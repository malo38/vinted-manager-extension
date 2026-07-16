/**
 * VintControl — Service Worker (background)
 * --------------------------------------------
 * Tourne en arrière-plan dans Chrome.
 * Toutes les 5 minutes : lit les données Vinted depuis un onglet ouvert
 * et les envoie au backend VintControl.
 */

const DEFAULT_BACKEND = 'https://web-production-662dc1.up.railway.app'
const SYNC_INTERVAL_MIN = 5
const SUPABASE_URL = 'https://iprrnmrndjfdlozxjbsu.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwcnJubXJuZGpmZGxvenhqYnN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NjUxOTksImV4cCI6MjA5ODA0MTE5OX0.JAteIwydCEoOe6S3z-Isq6-TwRLBdGpU8akn_1FvQb0'

// ── Config stockée localement ──
async function getConfig() {
  const d = await chrome.storage.local.get(['vm_token', 'vm_backend'])
  return {
    token: d.vm_token || '',
    backend: d.vm_backend || DEFAULT_BACKEND,
  }
}

async function setConfig(patch) {
  await chrome.storage.local.set(patch)
}

// ── Renouveler le token de connexion avant qu'il expire (~1h) ──
async function refreshAuthToken() {
  const { vm_refresh_token } = await chrome.storage.local.get(['vm_refresh_token'])
  if (!vm_refresh_token) return false
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: vm_refresh_token }),
    })
    if (!r.ok) return false
    const data = await r.json()
    if (!data.access_token) return false
    await chrome.storage.local.set({
      vm_token: data.access_token,
      vm_refresh_token: data.refresh_token || vm_refresh_token,
    })
    return true
  } catch {
    return false
  }
}

// ── Appel au backend (renouvelle et réessaie une fois si le token a expiré) ──
async function backendFetch(method, path, body = null) {
  const { token, backend } = await getConfig()
  if (!token) return null

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  }
  if (body) opts.body = JSON.stringify(body)

  try {
    let r = await fetch(`${backend}${path}`, opts)
    if (r.status === 401 && (await refreshAuthToken())) {
      const { token: freshToken } = await getConfig()
      opts.headers['Authorization'] = `Bearer ${freshToken}`
      r = await fetch(`${backend}${path}`, opts)
    }
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

// ── Trouver un onglet Vinted ouvert ──
async function getVintedTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.vinted.fr/*' })
  return tabs.find(t => !t.discarded) || tabs[0] || null
}

// ── Récupérer les données Vinted via le contexte de la page (cookies inclus) ──
async function fetchVintedData() {
  const tab = await getVintedTab()
  if (!tab) throw new Error('NO_TAB')

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      async function apiGet(path, params = {}) {
        const url = new URL(`https://www.vinted.fr/api/v2${path}`)
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
        const r = await fetch(url.toString(), {
          credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        })
        if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`)
        return r.json()
      }

      try {
        const userRaw = await apiGet('/users/current')
        const user = userRaw.user || {}
        const userId = user.id
        if (!userId) throw new Error('no_user_id')

        // Réputation (review_count / feedback_reputation confirmés via un vrai objet
        // "opposite_user" observé dans /api/v2/conversations le 2026-07-02 ; les autres
        // champs ci-dessous sont une tentative raisonnable, à vérifier une fois en usage).
        const reputation = {
          review_count: user.review_count ?? 0,
          feedback_reputation: user.feedback_reputation ?? 0,
          followers_count: user.followers_count ?? user.follower_count ?? 0,
          item_count: user.item_count ?? user.given_item_count ?? 0,
        }

        // /my_orders per_page=100/page=1 seul ratait toute vente au-delà des 100
        // plus récentes (article resté coincé en "stock" pour toujours, signalé
        // le 2026-07-15) — on pagine désormais jusqu'à 5 pages (500 commandes),
        // même heuristique d'arrêt que les autres endpoints paginés de ce
        // fichier (page renvoyée plus courte que per_page = dernière page).
        async function fetchAllOrders(orderType) {
          let all = []
          for (let page = 1; page <= 5; page++) {
            const data = await apiGet('/my_orders', { per_page: '100', page: String(page), order_type: orderType })
            const batch = data.my_orders || []
            all.push(...batch)
            if (batch.length < 100) break
          }
          return { my_orders: all }
        }

        // Vinted a utilisé plusieurs formes d'URL pour lister les annonces d'un
        // utilisateur au fil du temps. /wardrobe/{userId}/items est celle
        // vérifiée et utilisée depuis le début, mais si elle venait à changer
        // un jour, on retente /users/{userId}/items avant d'abandonner —
        // amortit un futur changement d'API plutôt que de casser net.
        async function fetchWardrobeItems() {
          try {
            return await apiGet(`/wardrobe/${userId}/items`, { per_page: '100', order: 'newest_first' })
          } catch (e) {
            const fallback = await apiGet(`/users/${userId}/items`, { per_page: '100' })
            return fallback
          }
        }

        const [ordersRaw, purchasesRaw, wardrobeRaw, inboxRaw, walletRaw] = await Promise.all([
          fetchAllOrders('sold'),
          fetchAllOrders('purchased').catch(() => ({ my_orders: [] })),
          fetchWardrobeItems(),
          apiGet('/inbox', { per_page: '50' }).catch(() => ({ conversations: [] })),
          // Solde du porte-monnaie : confirmé via /wallet/invoices/current le 2026-07-04
          // (balance.amount / pending_balance.amount).
          apiGet('/wallet/invoices/current').catch(() => ({})),
        ])

        const wallet = {
          balance: parseFloat(walletRaw?.balance?.amount ?? 0),
          pending_balance: parseFloat(walletRaw?.pending_balance?.amount ?? 0),
        }

        // Achats/ventes : le paramètre order_type de /my_orders ne filtre pas toujours
        // correctement côté Vinted (des ventes réelles vues le 2026-07-04 apparaissaient
        // dans la liste "purchased", et inversement un achat avait déjà été vu dans les
        // deux listes le 2026-07-03). On combine donc les deux appels, on dédoublonne par
        // transaction_id, et le tri achat/vente définitif se fait après coup (en dehors de
        // ce script injecté) via transaction.current_user_side, le seul champ fiable.
        const orderEntriesMap = new Map()
        const addOrder = (o, seenSold, seenPurchased) => {
          const id = String(o.transaction_id || o.id || '')
          if (!id) return
          const existing = orderEntriesMap.get(id)
          if (existing) {
            existing.seenSold = existing.seenSold || seenSold
            existing.seenPurchased = existing.seenPurchased || seenPurchased
            return
          }
          orderEntriesMap.set(id, {
            id,
            conversation_id: o.conversation_id || null,
            titre: o.title || '',
            prix: parseFloat(o.price?.amount ?? 0),
            statut: o.status || '',
            statut_code: o.transaction_user_status || '',
            date: (o.date || '').slice(0, 10),
            photo: o.photo?.url || '',
            seenSold,
            seenPurchased,
          })
        }
        ;(ordersRaw.my_orders || []).forEach(o => addOrder(o, true, false))
        ;(purchasesRaw.my_orders || []).forEach(o => addOrder(o, false, true))
        const orderEntries = Array.from(orderEntriesMap.values())

        // /wardrobe/{userId}/items renvoie aussi les annonces fermées/vendues
        // (parfois marquées "vendu" manuellement par le vendeur sans passer par
        // une vraie transaction Vinted, donc invisibles dans /my_orders) — le
        // champ is_closed le signale explicitement. Sans ce filtre, un article
        // fermé revenait indéfiniment marqué "stock" à chaque synchro (trouvé
        // le 2026-07-15 : is_closed:true sur un article qui ne réapparaissait
        // jamais dans les vraies ventes).
        const annonces = (wardrobeRaw.items || [])
          .filter(i => !i.is_closed)
          .map(i => ({
            id: String(i.id),
            titre: i.title || '',
            prix: parseFloat(i.price?.amount ?? i.price_numeric ?? 0),
            vues: i.view_count || 0,
            favoris: i.favourite_count || 0,
            photo: i.photo?.url || i.photos?.[0]?.url || '',
          }));

        // Vinted génère toujours ce même gabarit de texte pour une offre en attente
        // (confirmé via /inbox le 2026-07-03) : "Bonjour, accepterais-tu de me vendre
        // ceci à X,XX € ?" — on le détecte directement dans la liste, sans appel
        // supplémentaire par conversation.
        const OFFER_REGEX = /accepterais-tu de me vendre ceci à\s*([\d]+(?:,\d+)?)\s*€/i;
        const messages = (inboxRaw.conversations || []).map(c => {
          const dernier_message = c.description || c.last_message?.body || '';
          const offerMatch = dernier_message.match(OFFER_REGEX);
          return {
            id: String(c.id),
            interlocuteur: c.opposite_user?.login || '',
            dernier_message,
            non_lu: (c.unread_message_count || 0) > 0 || !!c.unread,
            updated_at: c.updated_at || '',
            est_offre: !!offerMatch,
            offre_prix: offerMatch ? parseFloat(offerMatch[1].replace(',', '.')) : null,
          };
        });

        return { ok: true, data: { user: { id: String(userId), login: user.login || '' }, reputation, wallet, orderEntries, annonces, messages } }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
  })

  const result = results?.[0]?.result
  if (!result?.ok) throw new Error(result?.error || 'fetch_failed')

  await enrichMessagesWithArticleTitle(tab.id, result.data.messages)
  const { ventes, achats } = await resolveOrderSides(tab.id, result.data.orderEntries)
  await enrichPickupInfo(tab.id, achats)
  result.data.ventes = ventes
  result.data.achats = achats
  delete result.data.orderEntries
  return result.data
}

// ── Adresse du point relais pour un achat en attente de retrait ──
// Vinted ne donne nulle part de date limite de retrait (ni dans l'app, ni
// dans l'API — c'est le transporteur qui gère ce délai en interne), mais le
// nom + l'adresse du point relais sont bien présents, dans le message système
// de la conversation liée ("Ton colis a été livré dans le Point Relais X...").
// Pas de cache ici (contrairement à resolveOrderSides) : un achat "en attente"
// doit être revérifié à chaque sync tant qu'il n'est pas récupéré, alors que
// le côté achat/vente d'une conversation ne change lui jamais.
const PICKUP_REGEX = /point relais|bureau de poste|point de retrait/i
async function enrichPickupInfo(tabId, achats) {
  const toCheck = achats.filter(a => PICKUP_REGEX.test(a.statut || '') && a.conversation_id).slice(0, 15)
  if (!toCheck.length) return

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (ids) => {
      async function apiGet(path) {
        const r = await fetch(`https://www.vinted.fr/api/v2${path}`, {
          credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }
      const out = {}
      for (const id of ids) {
        try {
          const detail = await apiGet(`/conversations/${id}`)
          const msgs = detail.messages || detail.conversation?.messages || []
          // Le message le plus récent mentionnant un point relais/bureau de
          // poste dans son sous-titre — s'il y en a plusieurs (livré, puis
          // récupéré), on veut le dernier état connu.
          const pickupMsgs = msgs.filter(m => /point relais|bureau de poste|point de retrait/i.test(m.entity?.subtitle || ''))
          const last = pickupMsgs[pickupMsgs.length - 1]
          out[id] = last ? { location: last.entity.subtitle, since: (last.created_at || '').slice(0, 10) } : null
        } catch {
          out[id] = null
        }
      }
      return out
    },
    args: [toCheck.map(a => a.conversation_id)],
  }).then(r => r?.[0]?.result || {}).catch(() => ({}))

  for (const a of toCheck) {
    const info = results[a.conversation_id]
    if (info) { a.pickup_location = info.location; a.pickup_since = info.since }
  }
}

// ── Titre de l'article concerné par chaque conversation ──
// Une conversation reste toujours liée au même article : on ne va donc
// chercher le titre qu'une seule fois par conversation, puis on le garde
// en cache local (évite un appel API par conversation à chaque sync).
async function enrichMessagesWithArticleTitle(tabId, messages) {
  const { vm_conv_article_titles } = await chrome.storage.local.get(['vm_conv_article_titles'])
  const cache = vm_conv_article_titles || {}
  const toFetch = messages.filter(m => !cache[m.id]).slice(0, 25)

  if (toFetch.length) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (ids) => {
        async function apiGet(path) {
          const r = await fetch(`https://www.vinted.fr/api/v2${path}`, {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }
        const out = {}
        for (const id of ids) {
          try {
            const detail = await apiGet(`/conversations/${id}`)
            const tx = detail.transaction || detail.conversation?.transaction || {}
            let title = tx.item_title || tx.item?.title || ''
            if (!title) {
              const msgs = detail.messages || detail.conversation?.messages || []
              title = msgs.find(m => m.entity?.item_title)?.entity?.item_title || ''
            }
            out[id] = title
          } catch {
            out[id] = ''
          }
        }
        return out
      },
      args: [toFetch.map(m => m.id)],
    }).then(r => r?.[0]?.result || {}).catch(() => ({}))

    for (const [id, title] of Object.entries(results)) {
      if (title) cache[id] = title
    }
    await chrome.storage.local.set({ vm_conv_article_titles: cache })
  }

  for (const m of messages) {
    m.article_titre = cache[m.id] || '';
  }
}

// ── Tri fiable achat/vente ──
// order_type ne filtre pas toujours correctement côté Vinted (voir plus haut) : le
// seul champ fiable est transaction.current_user_side ("buyer"/"seller"), renvoyé
// par /conversations/{id} (confirmé via un vrai objet le 2026-07-04, sur une vente
// réelle qui apparaissait à tort dans la liste "purchased"). On le met en cache par
// conversation car il ne change jamais pour une transaction donnée.
//
// Le même appel récupère aussi l'item_id Vinted de l'annonce vendue (tx.item_id,
// avec repli sur tx.item?.id) — c'est le même identifiant que celui utilisé pour
// l'annonce quand elle était encore en stock (voir fetchWardrobeItems). Sans ça,
// la vente était identifiée par l'id de la TRANSACTION (différent de l'id de
// l'ANNONCE), donc la synchro ne reconnaissait jamais "c'est le même article" et
// créait une deuxième fiche au lieu de faire passer l'article existant à "vendu"
// — bug des doublons stock/vendu signalé le 2026-07-15. Une commande "lot" (achat
// groupé) n'a pas d'item_id unique côté Vinted ; on retombe alors sur l'id de
// commande, comme avant.
async function resolveOrderSides(tabId, orderEntries) {
  const { vm_conv_transaction_side, vm_conv_item_id } = await chrome.storage.local.get(['vm_conv_transaction_side', 'vm_conv_item_id'])
  const sideCache = vm_conv_transaction_side || {}
  const itemIdCache = vm_conv_item_id || {}
  const toFetch = orderEntries.filter(o => o.conversation_id && !sideCache[o.conversation_id]).slice(0, 25)

  if (toFetch.length) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (ids) => {
        async function apiGet(path) {
          const r = await fetch(`https://www.vinted.fr/api/v2${path}`, {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }
        const out = {}
        for (const id of ids) {
          try {
            const detail = await apiGet(`/conversations/${id}`)
            const tx = detail.transaction || detail.conversation?.transaction || {}
            out[id] = { side: tx.current_user_side || '', itemId: tx.item_id || tx.item?.id || '' }
          } catch {
            out[id] = { side: '', itemId: '' }
          }
        }
        return out
      },
      args: [toFetch.map(o => o.conversation_id)],
    }).then(r => r?.[0]?.result || {}).catch(() => ({}))

    for (const [id, { side, itemId }] of Object.entries(results)) {
      if (side) sideCache[id] = side
      if (itemId) itemIdCache[id] = String(itemId)
    }
    await chrome.storage.local.set({ vm_conv_transaction_side: sideCache, vm_conv_item_id: itemIdCache })
  }

  const ventes = []
  const achats = []
  for (const o of orderEntries) {
    const side = sideCache[o.conversation_id]
    // Tant que le côté n'est pas encore résolu (plafonné à 25 nouvelles résolutions
    // par sync), on se rabat sur l'ancienne heuristique le temps que ça se résorbe.
    const isVente = side ? side === 'seller' : (o.seenSold && !o.seenPurchased)
    const base = { id: o.id, item_id: itemIdCache[o.conversation_id] || '', conversation_id: o.conversation_id, titre: o.titre, prix: o.prix, statut: o.statut, statut_code: o.statut_code, photo: o.photo }
    if (isVente) ventes.push({ ...base, date_vente: o.date })
    else achats.push({ ...base, date_achat: o.date })
  }
  return { ventes, achats }
}

// ── Notifications de nouveaux messages Vinted ──
async function notifyNewMessages(messages) {
  const { vm_notified_msg_keys } = await chrome.storage.local.get(['vm_notified_msg_keys'])
  const known = new Set(vm_notified_msg_keys || [])
  const unread = messages.filter(m => m.non_lu)
  const fresh = unread.filter(m => !known.has(`${m.id}|${m.updated_at}`))

  for (const m of fresh) {
    const prixTxt = m.offre_prix != null ? `${m.offre_prix.toFixed(2).replace('.', ',')} €` : ''
    chrome.notifications.create(`vm-msg-${m.id}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: m.est_offre ? `💰 Offre de ${m.interlocuteur || 'un utilisateur'}` : `Nouveau message de ${m.interlocuteur || 'un utilisateur'}`,
      message: m.est_offre ? `${m.interlocuteur || 'Un acheteur'} vous propose ${prixTxt}` : (m.dernier_message || 'Vous avez reçu un nouveau message sur Vinted.'),
      priority: m.est_offre ? 2 : 1,
    })
  }

  // On garde en mémoire l'état "déjà notifié" de tous les messages non lus actuels
  // (pas seulement les nouveaux) pour ne jamais re-notifier deux fois la même mise à jour.
  const updatedKnown = unread.map(m => `${m.id}|${m.updated_at}`)
  await chrome.storage.local.set({ vm_notified_msg_keys: updatedKnown })
}

// ── Message automatique aux favoris ──
// Un seul envoi par cycle de sync (toutes les 5 min, voir SYNC_INTERVAL_MIN) :
// pas de rafale ni d'attente artificielle dans le service worker (qui risque
// d'être tué par Chrome pendant une longue attente), le rythme de l'alarme
// suffit à espacer les envois naturellement.
// Extrait le CSRF (échappé dans le HTML, pas une balise <meta>) et l'anon-id
// (cookie) — seule partie qui doit tourner dans le contexte de la page.
async function getVintedAuthTokens(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const m = document.documentElement.innerHTML.match(/CSRF_TOKEN\\*"\s*:\s*\\*"([a-f0-9-]{20,})/i)
      const anonIdMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/)
      return { csrf: m ? m[1] : null, anonId: anonIdMatch ? decodeURIComponent(anonIdMatch[1]) : null }
    },
  })
  return results?.[0]?.result || {}
}

async function runAutoMessageFavoris() {
  // Réglages désormais PAR COMPTE Vinted : on ne lit que celui actuellement
  // connecté dans le navigateur, identifié via le dernier sync réussi
  // (toujours frais puisque cette fonction ne tourne que juste après).
  const { vm_vinted_user_id } = await chrome.storage.local.get(['vm_vinted_user_id'])
  const config = await backendFetch('GET', `/api/extension/automessage-config?vinted_user_id=${encodeURIComponent(vm_vinted_user_id || '')}`)
  if (!config?.enabled) return { ok: false, error: 'disabled', config }
  if (config.sent_today >= config.daily_limit) return { ok: false, error: 'daily_limit_reached', config }

  const tab = await getVintedTab()
  if (!tab) return { ok: false, error: 'no_vinted_tab' }

  let { csrf, anonId } = await getVintedAuthTokens(tab.id)
  if (!csrf) {
    // Repli : la page ouverte ne contient pas le token, on va le chercher
    // sur une page qui l'a toujours (/items/new). Cette requête part du
    // service worker (pas de la page) pour ne pas dépendre du contexte
    // d'un onglet précis.
    const r = await fetch('https://www.vinted.fr/items/new', { credentials: 'include' })
    const html = await r.text()
    const m = html.match(/CSRF_TOKEN\\*"\s*:\s*\\*"([a-f0-9-]{20,})/i)
    csrf = m ? m[1] : null
  }
  if (!csrf) return { ok: false, error: 'no_csrf_token' }

  const authHeaders = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'x-csrf-token': csrf,
    ...(anonId ? { 'x-anon-id': anonId } : {}),
  }

  // Les appels réseau tournent depuis le service worker (pas injectés dans
  // l'onglet) : api.vinted.fr rejette les requêtes cross-origin faites
  // depuis le contexte de la page www.vinted.fr (CORS), alors qu'une requête
  // faite par l'extension elle-même (host_permissions déclarées) n'y est pas
  // soumise (confirmé le 2026-07-14 après plusieurs échecs "Failed to fetch"
  // en injection).
  let notifications = []
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://api.vinted.fr/inbox-notifications/v1/notifications?page=${page}&per_page=20`, {
        credentials: 'include',
        headers: authHeaders,
      })
      if (!r.ok) return { ok: false, error: `notifications HTTP ${r.status}` }
      const data = await r.json()
      const batch = data.notifications || []
      notifications.push(...batch)
      if (batch.length < 20) break
    }
  } catch (e) {
    return { ok: false, error: 'notifications_fetch_failed', message: e.message }
  }
  // Deux formats de lien observés le même jour (2026-07-14) pour une même
  // notification de favori : "/items/{id}/want_it/new?offering_id=X" (juste
  // après le like) et "vintedfr://messaging?item_id=X&user_id=Y" (une fois
  // affichée dans la liste). On accepte les deux — le second est plus direct
  // (item_id + user_id explicites, plus besoin de deviner via subject_id).
  const favoriteNotifs = notifications.filter(n =>
    n.link && (n.link.includes('?offering_id=') || /messaging\?item_id=\d+&user_id=\d+/.test(n.link))
  )

  // Résoudre chaque favori en vraie conversation via le même appel que fait
  // le frontend de Vinted en arrière-plan quand on ouvre la notification
  // (confirmé le 2026-07-14 par capture réseau réelle — le lien de
  // redirection utilisé jusqu'ici est mort, Vinted route ça côté client
  // désormais). Idempotent : retrouve la conversation existante si elle
  // l'est déjà, sinon la crée. "messages: []" dans la réponse veut dire
  // qu'on n'a encore jamais répondu — sert de dédoublonnage.
  const debugTrace = []
  let found = null
  for (const n of favoriteNotifs) {
    try {
      const messagingMatch = n.link.match(/messaging\?item_id=(\d+)&user_id=(\d+)/)
      const offeringMatch = n.link.match(/offering_id=(\d+)/)
      const itemId = messagingMatch ? messagingMatch[1] : String(n.subject_id)
      const oppositeUserId = messagingMatch ? messagingMatch[2] : (offeringMatch ? offeringMatch[1] : null)
      if (!oppositeUserId) { debugTrace.push({ id: n.id, skip: 'no_user_id_resolved', link: n.link }); continue }
      const r = await fetch('https://www.vinted.fr/api/v2/conversations', {
        method: 'POST',
        credentials: 'include',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initiator: 'seller_enters_notification',
          item_id: itemId,
          opposite_user_id: oppositeUserId,
        }),
      })
      if (!r.ok) { debugTrace.push({ id: n.id, skip: `HTTP ${r.status}`, body: (await r.text().catch(() => '')).slice(0, 300) }); continue }
      const data = await r.json()
      const conv = data.conversation
      if (!conv) { debugTrace.push({ id: n.id, skip: 'no_conversation_in_response' }); continue }
      if ((conv.messages || []).length > 0) { debugTrace.push({ id: n.id, skip: 'already_has_messages' }); continue }
      const nameMatch = (n.body || '').match(/^(.+?)\s+a marqué/)
      found = {
        conversationId: String(conv.id),
        notifId: String(n.id),
        name: conv.opposite_user?.login || (nameMatch ? nameMatch[1] : ''),
      }
      break
    } catch (e) {
      debugTrace.push({ id: n.id, skip: 'exception', error: e.message })
    }
  }

  if (!found?.conversationId) return { ok: false, error: 'no_eligible_favorite_found', debug: { debugTrace, favoriteNotifCount: favoriteNotifs.length, notificationsCount: notifications.length, sampleLinks: notifications.slice(0, 3).map(n => n.link) } }

  const message = (config.template || '').replace(/\{item\}/g, found.name || 'cet article')
  if (!message.trim()) return { ok: false, error: 'empty_template', found }

  let sent
  try {
    const r = await fetch(`https://www.vinted.fr/api/v2/conversations/${found.conversationId}/replies`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: { body: message, photo_temp_uuids: null } }),
    })
    sent = r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}` }
  } catch (e) {
    sent = { ok: false, error: e.message }
  }
  if (sent?.ok) {
    await backendFetch('POST', '/api/extension/mark-messaged', {
      id: found.notifId,
      recipient_login: found.name,
      message,
      vinted_user_id: vm_vinted_user_id || '',
    })
  }
  return { ok: !!sent?.ok, error: sent?.error, recipient: found.name, conversationId: found.conversationId }
}

// ── Republication automatique (delete + recreate honnête, sans retouche) ──
// Un seul article republié par cycle de sync, pour les mêmes raisons que le
// message aux favoris ci-dessus. Ordre volontairement "créer d'abord, puis
// supprimer l'ancien" : si la création échoue en cours de route, l'annonce
// d'origine reste intacte plutôt que de se retrouver supprimée pour rien.
async function runAutoRepublish() {
  // Réglages PAR COMPTE Vinted, comme automessage-config (voir commentaire
  // équivalent dans runAutoMessageFavoris()).
  const { vm_vinted_user_id } = await chrome.storage.local.get(['vm_vinted_user_id'])
  const config = await backendFetch('GET', `/api/extension/republish-config?vinted_user_id=${encodeURIComponent(vm_vinted_user_id || '')}`)
  if (!config) return

  // Clic manuel "Republier maintenant" sur le site : passe devant la file
  // normale et ignore enabled/daily_limit — c'est une action explicite de
  // l'utilisateur, pas le cycle automatique. Le backend l'a déjà consommée
  // (remise à null) dès cette lecture, donc pas de risque de la relancer au
  // cycle suivant.
  if (config.priority_vinted_item_id) {
    await republishItemById(config.priority_vinted_item_id, vm_vinted_user_id)
    return
  }

  if (!config.enabled) return
  if (config.republished_today >= config.daily_limit) return
  const targetItemId = (config.eligible_vinted_item_ids || [])[0]
  if (!targetItemId) return

  await republishItemById(targetItemId, vm_vinted_user_id)
}

// Coeur de la republication, isolé de runAutoRepublish() pour pouvoir cibler
// un article précis plutôt que dépendre de la sélection automatique
// "premier éligible".
async function republishItemById(targetItemId, vintedUserId) {
  const tab = await getVintedTab()
  if (!tab) return { ok: false, error: 'no_vinted_tab' }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (itemId) => {
      // Le CSRF n'est pas dans une balise <meta> mais embarqué dans le HTML de
      // la page sous la forme "CSRF_TOKEN":"..." — l'anon-id vient du cookie
      // du même nom. Les deux sont exigés par les endpoints d'édition/écriture
      // (item_upload/*), pas par les endpoints de lecture publique.
      function extractCsrf(html) {
        // Le token apparaît parfois entre guillemets simples ("CSRF_TOKEN":"...")
        // et parfois échappés dans un payload Next.js (\"CSRF_TOKEN\":\"...\") —
        // on ignore les antislashs autour des guillemets plutôt que de matcher
        // un format précis.
        const m = html.match(/CSRF_TOKEN\\*"\s*:\s*\\*"([a-f0-9-]{20,})/i)
        return m ? m[1] : null
      }
      async function getCsrfToken() {
        const fromDom = extractCsrf(document.documentElement.innerHTML)
        if (fromDom) return fromDom
        // Le token n'est pas toujours injecté sur la page courante (ex: page
        // d'accueil du compte) — /items/new (formulaire de vente) l'a toujours.
        const r = await fetch('https://www.vinted.fr/items/new', { credentials: 'include' })
        return extractCsrf(await r.text())
      }
      function getAnonId() {
        const m = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/)
        return m ? decodeURIComponent(m[1]) : null
      }

      const csrf = await getCsrfToken()
      const anonId = getAnonId()
      const authHeaders = {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'x-enable-multiple-size-groups': 'true',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(anonId ? { 'x-anon-id': anonId } : {}),
      }

      async function apiGet(path) {
        const r = await fetch(`https://www.vinted.fr/api/v2${path}`, {
          credentials: 'include',
          headers: authHeaders,
        })
        if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`)
        return r.json()
      }

      try {
        if (!csrf) throw new Error('no_csrf_token')

        // 1. Détails complets de l'annonce actuelle. L'endpoint public
        // /items/{id} ne suffit pas (403/404 sans contexte d'édition) : il
        // faut l'endpoint utilisé par le formulaire d'édition lui-même.
        const detail = await apiGet(`/item_upload/items/${itemId}`)
        const item = detail.item || detail

        let colors = Array.isArray(item.color_ids) ? [...item.color_ids] : (Array.isArray(item.colors) ? [...item.colors] : [])
        for (let i = 0; i < 20; i++) {
          const key = `color${i}_id`
          if (item[key] != null) colors.push(item[key])
        }

        // 2. Retélécharger chaque photo existante (déjà publique sur le CDN
        // Vinted) et la réuploader telle quelle — aucune retouche.
        const tempUuid = crypto.randomUUID()
        const photoIds = []
        for (const photo of (item.photos || [])) {
          const url = typeof photo === 'string' ? photo : (photo.full_size_url || photo.url)
          if (!url) continue
          const blob = await (await fetch(url)).blob()
          const form = new FormData()
          form.append('photo[type]', 'item')
          form.append('photo[file]', blob, 'photo.jpg')
          form.append('photo[temp_uuid]', tempUuid)
          const uploadRes = await fetch('https://www.vinted.fr/api/v2/photos', {
            method: 'POST',
            credentials: 'include',
            headers: authHeaders,
            body: form,
          })
          if (!uploadRes.ok) throw new Error(`photo upload -> HTTP ${uploadRes.status}`)
          const uploadData = await uploadRes.json()
          photoIds.push(uploadData.id ?? uploadData.photo?.id)
        }
        if (!photoIds.length) throw new Error('no_photo_uploaded')

        // 3. Créer la nouvelle annonce, à l'identique (même titre, description,
        // marque, taille, catégorie, couleurs, état, prix), avant de toucher
        // à l'ancienne.
        const createRes = await fetch('https://www.vinted.fr/api/v2/item_upload/items', {
          method: 'POST',
          credentials: 'include',
          headers: { ...authHeaders, 'Content-Type': 'application/json', 'x-upload-form': 'true' },
          body: JSON.stringify({
            item: {
              id: null,
              currency: item.price?.currency_code || item.currency || 'EUR',
              temp_uuid: tempUuid,
              title: item.title,
              description: item.description,
              brand: item.brand_title || item.brand,
              brand_id: item.brand_id ?? null,
              size_id: item.size_id,
              catalog_id: item.catalog_id,
              status_id: item.status_id,
              package_size_id: item.package_size_id,
              is_unisex: item.is_unisex ?? false,
              price: parseFloat(item.price?.amount ?? item.price_numeric ?? item.original_price_numeric ?? item.price) || 0,
              color_ids: colors,
              assigned_photos: photoIds.map(id => ({ id, orientation: 0 })),
              measurement_length: item.measurement_length ?? null,
              measurement_width: item.measurement_width ?? null,
              item_attributes: item.item_attributes || [],
            },
            feedback_id: null,
            push_up: false,
            parcel: null,
            upload_session_id: tempUuid,
          }),
        })
        if (!createRes.ok) {
          const body = await createRes.text().catch(() => '')
          throw new Error(`create item -> HTTP ${createRes.status}: ${body.slice(0, 500)}`)
        }
        const createData = await createRes.json()
        const newItemId = createData.item?.id ?? createData.id
        if (!newItemId) throw new Error('no_new_item_id')

        // 4. Seulement maintenant, supprimer l'ancienne annonce.
        const deleteRes = await fetch(`https://www.vinted.fr/api/v2/items/${itemId}/delete`, {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders,
        })
        if (!deleteRes.ok) {
          // La nouvelle annonce existe mais l'ancienne aussi encore : pas
          // grave en soi (pas de perte), mais à signaler pour éviter un
          // doublon persistant.
          return { ok: true, newItemId, oldItemDeleteFailed: true }
        }

        return { ok: true, newItemId }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    args: [targetItemId],
  })

  const result = results?.[0]?.result
  if (!result?.ok) return result

  await backendFetch('POST', '/api/extension/mark-republished', {
    old_vinted_item_id: String(targetItemId),
    new_vinted_item_id: String(result.newItemId),
    vinted_user_id: vintedUserId || '',
  })
  return result
}

// ── Sync principale ──
async function syncVinted() {
  const { token } = await getConfig()
  if (!token) return { ok: false, reason: 'non_configure' }

  try {
    const data = await fetchVintedData()
    const payload = {
      vinted_user_id: data.user.id,
      vinted_login: data.user.login,
      reputation: data.reputation,
      wallet: data.wallet,
      ventes: data.ventes,
      achats: data.achats,
      annonces: data.annonces,
      messages: data.messages,
    }
    const syncResult = await backendFetch('POST', '/api/extension/sync', payload)
    if (!syncResult) {
      // Le backend n'a jamais reçu les données (token invalide, refresh échoué, etc.) :
      // ne JAMAIS afficher un succès trompeur (badge vert / "dernière synchro" à jour)
      // alors que rien n'a réellement été sauvegardé côté serveur.
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
      return { ok: false, reason: 'backend_unreachable' }
    }
    await setConfig({ vm_last_sync: new Date().toISOString(), vm_vinted_login: data.user.login, vm_vinted_user_id: data.user.id })
    notifyNewMessages(data.messages).catch(() => {})
    chrome.action.setBadgeText({ text: '✓' })
    chrome.action.setBadgeBackgroundColor({ color: '#00e5a0' })
    return { ok: true, ventes: data.ventes.length, annonces: data.annonces.length }
  } catch (e) {
    if (e.message === 'NO_TAB') {
      return { ok: false, reason: 'no_vinted_tab' }
    }
    // Le popup n'affichait jusqu'ici qu'un message générique ("✗ Erreur —
    // réessayez") pour toute erreur non reconnue, sans jamais dire LAQUELLE
    // — impossible à diagnostiquer sans ouvrir la console du service worker.
    // On logue le détail ici (visible via chrome://extensions → VintControl
    // → "service worker") et on renvoie e.message tel quel au popup, qui
    // l'affiche maintenant directement (voir popup.js) — signalé le 2026-07-15.
    console.error('[VintControl] Échec de synchro :', e)
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
    return { ok: false, reason: e.message }
  }
}

// ── Alarmes ──
chrome.alarms.create('sync', { periodInMinutes: SYNC_INTERVAL_MIN })
chrome.alarms.create('refresh_token', { periodInMinutes: 45 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync') {
    const result = await syncVinted()
    // Les deux automatisations ont besoin d'un onglet Vinted valide et d'une
    // synchro qui vient de réussir (données à jour côté backend) avant de
    // s'exécuter — inutile de les tenter si la synchro elle-même a échoué.
    if (result.ok) {
      await runAutoMessageFavoris().catch(() => {})
      await runAutoRepublish().catch(() => {})
    }
  }
  if (alarm.name === 'refresh_token') await refreshAuthToken()
})

// ── Messages depuis le popup ──
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.action === 'sync_now') {
    syncVinted().then(respond)
    return true
  }
  if (msg.action === 'get_status') {
    chrome.storage.local.get(['vm_token', 'vm_last_sync', 'vm_vinted_login'], respond)
    return true
  }
  if (msg.action === 'save_token') {
    setConfig({ vm_token: msg.token }).then(() => respond({ ok: true }))
    return true
  }
  if (msg.action === 'logout') {
    chrome.storage.local.clear()
    chrome.action.setBadgeText({ text: '' })
    respond({ ok: true })
    return true
  }
})

chrome.runtime.onStartup.addListener(syncVinted)
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: SYNC_INTERVAL_MIN })
  chrome.alarms.create('refresh_token', { periodInMinutes: 45 })
})

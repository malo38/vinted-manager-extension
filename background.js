/**
 * Vinted Manager — Service Worker (background)
 * --------------------------------------------
 * Tourne en arrière-plan dans Chrome.
 * Toutes les 5 minutes : lit les données Vinted depuis un onglet ouvert
 * et les envoie au backend Vinted Manager.
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

        const [ordersRaw, purchasesRaw, wardrobeRaw, inboxRaw, walletRaw] = await Promise.all([
          apiGet('/my_orders', { per_page: '100', page: '1', order_type: 'sold' }),
          apiGet('/my_orders', { per_page: '100', page: '1', order_type: 'purchased' }).catch(() => ({ my_orders: [] })),
          apiGet(`/wardrobe/${userId}/items`, { per_page: '100', order: 'newest_first' }),
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

        const annonces = (wardrobeRaw.items || []).map(i => ({
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
  result.data.ventes = ventes
  result.data.achats = achats
  delete result.data.orderEntries
  return result.data
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
async function resolveOrderSides(tabId, orderEntries) {
  const { vm_conv_transaction_side } = await chrome.storage.local.get(['vm_conv_transaction_side'])
  const cache = vm_conv_transaction_side || {}
  const toFetch = orderEntries.filter(o => o.conversation_id && !cache[o.conversation_id]).slice(0, 25)

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
            out[id] = tx.current_user_side || ''
          } catch {
            out[id] = ''
          }
        }
        return out
      },
      args: [toFetch.map(o => o.conversation_id)],
    }).then(r => r?.[0]?.result || {}).catch(() => ({}))

    for (const [id, side] of Object.entries(results)) {
      if (side) cache[id] = side
    }
    await chrome.storage.local.set({ vm_conv_transaction_side: cache })
  }

  const ventes = []
  const achats = []
  for (const o of orderEntries) {
    const side = cache[o.conversation_id]
    // Tant que le côté n'est pas encore résolu (plafonné à 25 nouvelles résolutions
    // par sync), on se rabat sur l'ancienne heuristique le temps que ça se résorbe.
    const isVente = side ? side === 'seller' : (o.seenSold && !o.seenPurchased)
    const base = { id: o.id, titre: o.titre, prix: o.prix, statut: o.statut, statut_code: o.statut_code, photo: o.photo }
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
    await setConfig({ vm_last_sync: new Date().toISOString(), vm_vinted_login: data.user.login })
    notifyNewMessages(data.messages).catch(() => {})
    chrome.action.setBadgeText({ text: '✓' })
    chrome.action.setBadgeBackgroundColor({ color: '#00e5a0' })
    return { ok: true, ventes: data.ventes.length, annonces: data.annonces.length }
  } catch (e) {
    if (e.message === 'NO_TAB') {
      return { ok: false, reason: 'no_vinted_tab' }
    }
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
    return { ok: false, reason: e.message }
  }
}

// ── Alarmes ──
chrome.alarms.create('sync', { periodInMinutes: SYNC_INTERVAL_MIN })
chrome.alarms.create('refresh_token', { periodInMinutes: 45 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync') await syncVinted()
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

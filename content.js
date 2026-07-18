/**
 * VintControl — Bulle flottante sur vinted.fr
 * --------------------------------------------
 * Reprend le statut/sync déjà disponibles dans le popup, mais accessible
 * directement sur la page (comme Vinteer) plutôt que de devoir cliquer sur
 * l'icône de la barre d'outils — demandé le 2026-07-17.
 * Un Shadow DOM isole notre CSS de celui de Vinted (et inversement).
 */
;(() => {
  if (document.getElementById('vintcontrol-bubble-host')) return

  const host = document.createElement('div')
  host.id = 'vintcontrol-bubble-host'
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;'
  document.documentElement.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      .bubble {
        width: 48px; height: 48px; border-radius: 50%; background: #1a1a1a;
        border: 2px solid #6b7280; display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.35); position: relative;
        transition: border-color 0.2s;
      }
      .bubble img { width: 26px; height: 26px; display: block; }
      .dot {
        position: absolute; bottom: -2px; right: -2px; width: 14px; height: 14px;
        border-radius: 50%; background: #6b7280; border: 2px solid #1a1a1a;
      }
      .panel {
        display: none; position: absolute; bottom: 58px; right: 0; width: 260px;
        background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 10px;
        padding: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); color: #f0f0f0;
      }
      .panel.open { display: block; }
      .brand { font-size: 13px; font-weight: 700; color: #00e5a0; margin-bottom: 10px; }
      .row { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 6px; color: #ccc; }
      .row span:last-child { font-weight: 600; color: #fff; }
      .msg { font-size: 12px; color: #f59e0b; margin-bottom: 8px; line-height: 1.4; }
      button {
        width: 100%; padding: 8px; background: #00e5a0; color: #000; border: none;
        border-radius: 7px; font-weight: 700; cursor: pointer; font-size: 12.5px; font-family: inherit;
      }
      button:hover { opacity: 0.88; }
    </style>
    <div class="bubble" id="bubble">
      <span class="dot" id="dot"></span>
    </div>
    <div class="panel" id="panel"></div>
  `

  const bubble = root.getElementById('bubble')
  const dot = root.getElementById('dot')
  const panel = root.getElementById('panel')

  const iconUrl = chrome.runtime.getURL('icons/icon48.png')
  bubble.innerHTML = `<img src="${iconUrl}" alt="VintControl" /><span class="dot" id="dot"></span>`

  async function render() {
    const status = await chrome.storage.local.get(['vm_token', 'vm_vinted_login', 'vm_last_sync'])
    const dotEl = root.getElementById('dot')
    if (!status.vm_token) {
      dotEl.style.background = '#6b7280'
      panel.innerHTML = `<div class="brand">VintControl</div><div class="msg">Connecte-toi via l'icône de l'extension dans la barre d'outils.</div>`
      return
    }
    dotEl.style.background = '#00e5a0'
    const lastSync = status.vm_last_sync ? new Date(status.vm_last_sync).toLocaleTimeString('fr-FR') : 'Jamais'
    panel.innerHTML = `
      <div class="brand">VintControl</div>
      <div class="row"><span>Compte</span><span>@${status.vm_vinted_login || '—'}</span></div>
      <div class="row"><span>Dernière sync</span><span id="lastSyncVal">${lastSync}</span></div>
      <button id="syncBtn">🔄 Synchroniser maintenant</button>
    `
    root.getElementById('syncBtn').addEventListener('click', async (e) => {
      const btn = e.target
      btn.textContent = 'Synchronisation...'
      const result = await new Promise(r => chrome.runtime.sendMessage({ action: 'sync_now' }, r))
      if (result?.ok) btn.textContent = `✓ ${result.annonces} articles synchronisés`
      else if (result?.reason === 'no_vinted_tab') btn.textContent = '⚠️ Rechargez cette page'
      else btn.textContent = result?.reason ? `✗ ${result.reason}` : '✗ Erreur — réessayez'
      setTimeout(() => render(), 2000)
    })
  }

  bubble.addEventListener('click', () => {
    panel.classList.toggle('open')
    if (panel.classList.contains('open')) render()
  })
  document.addEventListener('click', (e) => {
    if (!host.contains(e.composedPath()[0]) && panel.classList.contains('open')) panel.classList.remove('open')
  })

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vm_token || changes.vm_last_sync) render()
  })

  render()
})()

const SUPABASE_URL = 'https://iprrnmrndjfdlozxjbsu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwcnJubXJuZGpmZGxvenhqYnN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NjUxOTksImV4cCI6MjA5ODA0MTE5OX0.JAteIwydCEoOe6S3z-Isq6-TwRLBdGpU8akn_1FvQb0';
const BACKEND = 'https://web-production-662dc1.up.railway.app';

async function checkStatus() {
  const status = await chrome.storage.local.get(['vm_token', 'vm_vinted_login', 'vm_last_sync']);
  if (status?.vm_token) {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('statusSection').style.display = 'block';
    document.getElementById('vintedLogin').textContent = status.vm_vinted_login || '—';
    document.getElementById('lastSync').textContent = status.vm_last_sync
      ? new Date(status.vm_last_sync).toLocaleTimeString('fr-FR')
      : 'Jamais';
  } else {
    document.getElementById('loginSection').style.display = 'block';
    document.getElementById('statusSection').style.display = 'none';
  }
}

document.getElementById('btnLogin').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  if (!email || !password) { errorEl.textContent = 'Remplissez tous les champs.'; return; }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) { errorEl.textContent = 'Email ou mot de passe incorrect.'; return; }
    await chrome.storage.local.set({ vm_token: data.access_token, vm_refresh_token: data.refresh_token || '' });
    await checkStatus();
  } catch (e) { errorEl.textContent = 'Erreur de connexion.'; }
});

document.getElementById('btnSync').addEventListener('click', async () => {
  const btn = document.getElementById('btnSync');
  btn.textContent = 'Synchronisation...';
  const result = await new Promise(r => chrome.runtime.sendMessage({ action: 'sync_now' }, r));
  if (result?.ok) {
    btn.textContent = `✓ ${result.annonces} articles synchronisés`;
  } else if (result?.reason === 'no_vinted_tab') {
    btn.textContent = '⚠️ Ouvrez un onglet vinted.fr';
  } else if (result?.reason === 'backend_unreachable') {
    btn.textContent = '✗ Connexion expirée — déconnectez-vous et reconnectez-vous';
  } else {
    btn.textContent = '✗ Erreur — réessayez';
  }
  setTimeout(() => { btn.textContent = '🔄 Synchroniser maintenant'; checkStatus(); }, 2500);
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  await checkStatus();
});

checkStatus();

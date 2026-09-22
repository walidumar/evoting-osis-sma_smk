// Helper fetch terpusat: otomatis menyertakan cookie session & token CSRF pada request yang mengubah state.
let _csrfToken = null;

async function getCsrfToken() {
  if (_csrfToken) return _csrfToken;
  const res = await fetch('/api/csrf-token', { credentials: 'include' });
  const data = await res.json();
  _csrfToken = data.csrfToken;
  return _csrfToken;
}

async function apiGet(url) {
  const res = await fetch(url, { credentials: 'include' });
  const data = await res.json().catch(() => ({ ok: false, message: 'Respon server tidak valid.' }));
  return { status: res.status, ...data };
}

async function apiSend(url, method, body, isFormData = false) {
  const token = await getCsrfToken();
  const headers = { 'X-CSRF-Token': token };
  let payload = body;
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body || {});
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'include' });
  const data = await res.json().catch(() => ({ ok: false, message: 'Respon server tidak valid.' }));
  return { status: res.status, ...data };
}

const apiPost = (url, body, isFormData) => apiSend(url, 'POST', body, isFormData);
const apiPut = (url, body, isFormData) => apiSend(url, 'PUT', body, isFormData);
const apiPatch = (url, body, isFormData) => apiSend(url, 'PATCH', body, isFormData);
const apiDelete = (url) => apiSend(url, 'DELETE', {});

function fmtNum(n) {
  return new Intl.NumberFormat('id-ID').format(n || 0);
}
function fmtPercent(n) {
  return new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0) + '%';
}

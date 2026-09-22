const ADMIN_MENU = [
  { href: '/admin/dashboard.html', label: 'Dashboard' },
  { href: '/admin/pemilih.html', label: 'Data Pemilih' },
  { href: '/admin/import.html', label: 'Import Data' },
  { href: '/admin/paslon.html', label: 'Paslon' },
  { href: '/admin/pengaturan.html', label: 'Pengaturan' },
  { href: '/admin/audit.html', label: 'Audit Log' },
];

function renderAdminNav() {
  const path = window.location.pathname;
  const nav = document.getElementById('adminNav');
  if (!nav) return;
  nav.innerHTML = `
    <div class="flex items-center justify-between px-4 md:px-8 py-3 bg-slate-900 border-b border-white/10">
      <div class="flex items-center gap-6 overflow-x-auto">
        <span class="font-bold text-white whitespace-nowrap">E-Voting OSIS <span class="text-blue-400">Admin</span></span>
        <div class="flex gap-1">
          ${ADMIN_MENU.map(m => `<a href="${m.href}" class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${path === m.href ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/5'}">${m.label}</a>`).join('')}
        </div>
      </div>
      <button id="btnLogout" class="text-sm text-slate-400 hover:text-red-400 whitespace-nowrap">Keluar</button>
    </div>
  `;
  document.getElementById('btnLogout').addEventListener('click', async () => {
    await apiPost('/api/admin/logout', {});
    window.location.href = '/admin/login.html';
  });
}

// Guard: panggil di setiap halaman admin (selain login.html) untuk memastikan sesi valid
async function guardAdmin() {
  const r = await apiGet('/api/admin/me');
  if (!r.ok) {
    window.location.href = '/admin/login.html';
    return null;
  }
  renderAdminNav();
  return r.data;
}

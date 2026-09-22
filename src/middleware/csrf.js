const crypto = require('crypto');

// Endpoint untuk mengambil token CSRF (dipanggil frontend saat load halaman)
function issueCsrfToken(req, res) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ ok: true, csrfToken: req.session.csrfToken });
}

// Middleware verifikasi: wajib dipasang pada semua route POST/PUT/PATCH/DELETE yang mengubah state
function verifyCsrf(req, res, next) {
  const headerToken = req.get('X-CSRF-Token');
  const sessionToken = req.session && req.session.csrfToken;

  if (!sessionToken || !headerToken || headerToken !== sessionToken) {
    return res.status(403).json({ ok: false, error: 'CSRF_INVALID', message: 'Token CSRF tidak valid atau kadaluarsa. Muat ulang halaman.' });
  }
  return next();
}

module.exports = { issueCsrfToken, verifyCsrf };

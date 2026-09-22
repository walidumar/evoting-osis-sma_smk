const rateLimit = require('express-rate-limit');
const db = require('../db/database');

// Lapis 1: rate limit per-IP (mencegah flood mentah). Sengaja agak longgar karena
// banyak siswa bisa berada di belakang NAT/IP sekolah yang sama.
const loginIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 menit
  max: 60,                  // 60 percobaan / 10 menit / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS', message: 'Terlalu banyak percobaan dari jaringan ini. Coba lagi beberapa menit lagi.' },
});

const votingActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS', message: 'Terlalu banyak permintaan. Coba lagi sesaat lagi.' },
});

// Lapis 2: rate limit per-IDENTITAS (NISN/NIK/username) - lebih ketat, disimpan di DB
// supaya bertahan meski server restart, dan tidak bisa dihindari dengan ganti IP kalau
// identitas yang dicoba tetap sama (mis. NISN diacak brute force dari banyak IP).
function checkIdentityLockout({ maxAttempts = 5, windowMinutes = 15 } = {}) {
  return function (req, res, next) {
    const identity = (req.body && (req.body.nisn || req.body.nik || req.body.username || '')).toString().trim();
    if (!identity) return next();

    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM login_attempts
      WHERE identity = ? AND success = 0 AND created_at >= ?
    `).get(identity, since.replace('T', ' ').substring(0, 19));

    if (row.cnt >= maxAttempts) {
      return res.status(429).json({
        ok: false,
        error: 'IDENTITY_LOCKED',
        message: `Terlalu banyak percobaan gagal untuk identitas ini. Coba lagi dalam ${windowMinutes} menit atau hubungi panitia.`,
      });
    }
    req._identityForLockout = identity;
    return next();
  };
}

function recordLoginAttempt(identity, success, req) {
  if (!identity) return;
  db.prepare(`INSERT INTO login_attempts (identity, ip_address, success) VALUES (?, ?, ?)`)
    .run(identity, req.ip, success ? 1 : 0);
}

module.exports = { loginIpLimiter, votingActionLimiter, checkIdentityLockout, recordLoginAttempt };

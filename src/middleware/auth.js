function requireAdmin(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.id) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Sesi admin tidak valid atau sudah habis. Silakan login kembali.' });
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.role === 'superadmin') {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Aksi ini hanya untuk superadmin.' });
}

// Voter harus sudah lolos verifikasi identitas (NISN/NIK) SEBELUM boleh mengakses halaman pilih/submit vote.
// Catatan: yang disimpan di session adalah voterId (PK internal) + voterType, BUKAN NISN/NIK mentah.
function requireVoterSession(req, res, next) {
  if (req.session && req.session.voter && req.session.voter.id && req.session.voter.type) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'NO_VOTER_SESSION', message: 'Sesi pemilih tidak ditemukan. Silakan login ulang.' });
}

module.exports = { requireAdmin, requireSuperAdmin, requireVoterSession };

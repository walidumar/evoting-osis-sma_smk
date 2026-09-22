const express = require('express');
const db = require('../db/database');
const { requireVoterSession } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { loginIpLimiter, votingActionLimiter, checkIdentityLockout, recordLoginAttempt } = require('../middleware/rateLimit');
const { logAudit } = require('../utils/audit');

const router = express.Router();

function getElectionStatus() {
  return db.prepare('SELECT status FROM election_settings WHERE id = 1').get().status;
}

class VoteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- LOGIN SISWA ----------
router.post('/login-siswa', loginIpLimiter, checkIdentityLockout({ maxAttempts: 5, windowMinutes: 15 }), verifyCsrf, (req, res) => {
  const nisn = String(req.body.nisn || '').trim();
  if (!nisn) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'NISN wajib diisi.' });

  if (getElectionStatus() !== 'berlangsung') {
    recordLoginAttempt(nisn, false, req);
    return res.status(403).json({ ok: false, error: 'ELECTION_NOT_ACTIVE', message: 'Pemilihan belum dimulai atau sudah selesai.' });
  }

  const student = db.prepare('SELECT id, nama, kelas, jurusan, status, has_voted FROM students WHERE nisn = ?').get(nisn);

  if (!student) {
    recordLoginAttempt(nisn, false, req);
    logAudit(req, 'LOGIN_SISWA_FAILED', `NISN tidak ditemukan`);
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Data NISN tidak ditemukan. Silakan hubungi panitia.' });
  }
  if (student.status !== 'active') {
    recordLoginAttempt(nisn, false, req);
    return res.status(403).json({ ok: false, error: 'INACTIVE', message: 'Data pemilih tidak aktif. Silakan hubungi panitia.' });
  }
  if (student.has_voted) {
    recordLoginAttempt(nisn, true, req);
    return res.status(403).json({ ok: false, error: 'ALREADY_VOTED', message: 'Anda sudah menggunakan hak suara.' });
  }

  recordLoginAttempt(nisn, true, req);

  const preservedCsrfToken = req.session.csrfToken;
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ ok: false, error: 'SESSION_ERROR', message: 'Gagal membuat sesi.' });
    // Simpan hanya ID internal + tipe pemilih di session, BUKAN NISN mentah.
    req.session.voter = { type: 'siswa', id: student.id, verifiedAt: Date.now() };
    req.session.csrfToken = preservedCsrfToken;
    logAudit(req, 'LOGIN_SISWA_SUCCESS', `Siswa id=${student.id} berhasil login`);
    res.json({ ok: true, data: { nama: student.nama, kelas: student.kelas, jurusan: student.jurusan } });
  });
});

// ---------- LOGIN GURU ----------
router.post('/login-guru', loginIpLimiter, checkIdentityLockout({ maxAttempts: 5, windowMinutes: 15 }), verifyCsrf, (req, res) => {
  const nik = String(req.body.nik || '').trim();
  if (!nik) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'NIK wajib diisi.' });

  if (getElectionStatus() !== 'berlangsung') {
    recordLoginAttempt(nik, false, req);
    return res.status(403).json({ ok: false, error: 'ELECTION_NOT_ACTIVE', message: 'Pemilihan belum dimulai atau sudah selesai.' });
  }

  const teacher = db.prepare('SELECT id, nama, jabatan, status, has_voted FROM teachers WHERE nik = ?').get(nik);

  if (!teacher) {
    recordLoginAttempt(nik, false, req);
    logAudit(req, 'LOGIN_GURU_FAILED', `NIK tidak ditemukan`);
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Data NIK tidak ditemukan. Silakan hubungi panitia.' });
  }
  if (teacher.status !== 'active') {
    recordLoginAttempt(nik, false, req);
    return res.status(403).json({ ok: false, error: 'INACTIVE', message: 'Data pemilih tidak aktif. Silakan hubungi panitia.' });
  }
  if (teacher.has_voted) {
    recordLoginAttempt(nik, true, req);
    return res.status(403).json({ ok: false, error: 'ALREADY_VOTED', message: 'Anda sudah menggunakan hak suara.' });
  }

  recordLoginAttempt(nik, true, req);

  const preservedCsrfToken = req.session.csrfToken;
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ ok: false, error: 'SESSION_ERROR', message: 'Gagal membuat sesi.' });
    req.session.voter = { type: 'guru', id: teacher.id, verifiedAt: Date.now() };
    req.session.csrfToken = preservedCsrfToken;
    logAudit(req, 'LOGIN_GURU_SUCCESS', `Guru id=${teacher.id} berhasil login`);
    res.json({ ok: true, data: { nama: teacher.nama, jabatan: teacher.jabatan } });
  });
});

// ---------- CEK SESI PEMILIH ----------
router.get('/me', requireVoterSession, (req, res) => {
  const { type, id } = req.session.voter;
  const table = type === 'siswa' ? 'students' : 'teachers';
  const row = db.prepare(`SELECT nama, has_voted FROM ${table} WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  res.json({ ok: true, data: { type, nama: row.nama, has_voted: !!row.has_voted } });
});

// ---------- DAFTAR PASLON (untuk halaman pemilihan, hanya bisa diakses setelah login) ----------
router.get('/candidates', requireVoterSession, (req, res) => {
  const rows = db.prepare(`
    SELECT id, nomor_urut, nama_ketua, nama_wakil, foto, visi
    FROM candidates WHERE status = 'active' ORDER BY nomor_urut ASC
  `).all();
  res.json({ ok: true, data: rows });
});

// ---------- SUBMIT VOTE (final, setelah konfirmasi di frontend) ----------
router.post('/vote', requireVoterSession, votingActionLimiter, verifyCsrf, (req, res) => {
  const candidateId = Number(req.body.candidate_id);
  const { type, id: voterId } = req.session.voter;

  if (!candidateId) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Paslon tidak valid.' });
  }
  if (getElectionStatus() !== 'berlangsung') {
    return res.status(403).json({ ok: false, error: 'ELECTION_NOT_ACTIVE', message: 'Pemilihan belum/tidak sedang berlangsung.' });
  }

  const table = type === 'siswa' ? 'students' : 'teachers';

  const castVote = db.transaction(() => {
    const voter = db.prepare(`SELECT has_voted FROM ${table} WHERE id = ?`).get(voterId);
    if (!voter) throw new VoteError('VOTER_NOT_FOUND', 'Data pemilih tidak ditemukan.');
    if (voter.has_voted) throw new VoteError('ALREADY_VOTED', 'Anda sudah menggunakan hak suara.');

    const candidate = db.prepare(`SELECT id FROM candidates WHERE id = ? AND status = 'active'`).get(candidateId);
    if (!candidate) throw new VoteError('CANDIDATE_INVALID', 'Paslon yang dipilih tidak valid atau sudah dinonaktifkan.');

    // Klausa "WHERE has_voted = 0" adalah kunci anti double-voting & anti race-condition:
    // hanya SATU request yang bisa berhasil meng-update baris ini dari has_voted=0 -> 1.
    const result = db.prepare(`UPDATE ${table} SET has_voted = 1, voted_at = datetime('now') WHERE id = ? AND has_voted = 0`).run(voterId);
    if (result.changes !== 1) throw new VoteError('ALREADY_VOTED', 'Anda sudah menggunakan hak suara.');

    // Tabel votes TIDAK menyimpan voter_id -> pilihan tidak bisa ditelusuri balik ke identitas pemilih.
    db.prepare(`INSERT INTO votes (candidate_id, voter_type) VALUES (?, ?)`).run(candidateId, type);
  });

  try {
    castVote();
  } catch (e) {
    if (e instanceof VoteError) {
      return res.status(409).json({ ok: false, error: e.code, message: e.message });
    }
    console.error('[VOTE_ERROR]', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Terjadi kesalahan server saat menyimpan suara.' });
  }

  // Audit log HANYA mencatat bahwa pemilih telah memilih, TANPA mencatat paslon yang dipilih (privasi).
  logAudit(req, 'VOTE_CAST', `${type} id=${voterId} telah menggunakan hak suara`);

  // Hapus session voting setelah berhasil.
  req.session.voter = null;
  req.session.save(() => {
    res.json({ ok: true, message: 'Suara Anda berhasil disimpan. Terima kasih telah berpartisipasi.' });
  });
});

router.post('/logout', (req, res) => {
  req.session.voter = null;
  res.json({ ok: true });
});

module.exports = router;

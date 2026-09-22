const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/database');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { loginIpLimiter, checkIdentityLockout, recordLoginAttempt } = require('../middleware/rateLimit');
const { logAudit } = require('../utils/audit');
const { upload, uploadDataFile, processAndSavePhoto, deletePhotoIfExists } = require('../utils/photoUpload');
const { parseSiswaFile, parseGuruFile, parseGabunganFile } = require('../utils/importParser');

const router = express.Router();

// ================= AUTH ADMIN =================
router.post('/login', loginIpLimiter, checkIdentityLockout({ maxAttempts: 8, windowMinutes: 15 }), verifyCsrf, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Username dan password wajib diisi.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  const passwordOk = user ? bcrypt.compareSync(password, user.password) : false;

  if (!user || !passwordOk || user.status !== 'active') {
    recordLoginAttempt(username, false, req);
    logAudit(req, 'ADMIN_LOGIN_FAILED', `Percobaan login gagal untuk username=${username}`);
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', message: 'Username atau password salah.' });
  }

  recordLoginAttempt(username, true, req);

  const preservedCsrfToken = req.session.csrfToken; // dibawa ke sesi baru agar token yg sudah dipegang klien tetap valid
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ ok: false, error: 'SESSION_ERROR' });
    req.session.admin = { id: user.id, username: user.username, role: user.role };
    req.session.csrfToken = preservedCsrfToken;
    logAudit(req, 'ADMIN_LOGIN_SUCCESS', `Admin ${user.username} login`, user.id);
    res.json({ ok: true, data: { username: user.username, role: user.role } });
  });
});

router.post('/logout', requireAdmin, (req, res) => {
  logAudit(req, 'ADMIN_LOGOUT', `Admin ${req.session.admin.username} logout`, req.session.admin.id);
  req.session.admin = null;
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true, data: req.session.admin });
});

router.post('/change-password', requireAdmin, verifyCsrf, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Password baru minimal 8 karakter.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.admin.id);
  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', message: 'Password lama salah.' });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`).run(hash, user.id);
  logAudit(req, 'ADMIN_CHANGE_PASSWORD', `Admin ${user.username} mengubah password`, user.id);
  res.json({ ok: true, message: 'Password berhasil diubah.' });
});

// Semua route di bawah ini WAJIB login admin
router.use(requireAdmin);

// ================= DASHBOARD =================
router.get('/dashboard/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM students WHERE status='active') AS total_siswa,
      (SELECT COUNT(*) FROM teachers WHERE status='active') AS total_guru,
      (SELECT COUNT(*) FROM students WHERE status='active' AND has_voted=1) AS siswa_sudah,
      (SELECT COUNT(*) FROM teachers WHERE status='active' AND has_voted=1) AS guru_sudah
  `).get();

  const totalPemilih = totals.total_siswa + totals.total_guru;
  const sudahMemilih = totals.siswa_sudah + totals.guru_sudah;
  const belumMemilih = totalPemilih - sudahMemilih;
  const persentase = totalPemilih > 0 ? Number(((sudahMemilih / totalPemilih) * 100).toFixed(2)) : 0;

  const candidateVotes = db.prepare(`
    SELECT c.id, c.nomor_urut, c.nama_ketua, c.nama_wakil, COALESCE(v.total,0) AS total_suara
    FROM candidates c
    LEFT JOIN (SELECT candidate_id, COUNT(*) total FROM votes GROUP BY candidate_id) v ON v.candidate_id = c.id
    WHERE c.status='active' ORDER BY c.nomor_urut ASC
  `).all();

  // Voting berdasarkan waktu: agregasi per jam (untuk grafik tren partisipasi)
  const votesByHour = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00', created_at) AS jam, COUNT(*) AS jumlah
    FROM votes GROUP BY jam ORDER BY jam ASC
  `).all();

  res.json({
    ok: true,
    data: {
      total_siswa: totals.total_siswa,
      total_guru: totals.total_guru,
      total_pemilih: totalPemilih,
      sudah_memilih: sudahMemilih,
      belum_memilih: belumMemilih,
      persentase_partisipasi: persentase,
      partisipasi_siswa: totals.total_siswa > 0 ? Number(((totals.siswa_sudah / totals.total_siswa) * 100).toFixed(2)) : 0,
      partisipasi_guru: totals.total_guru > 0 ? Number(((totals.guru_sudah / totals.total_guru) * 100).toFixed(2)) : 0,
      suara_per_paslon: candidateVotes,
      voting_by_hour: votesByHour,
    },
  });
});

// Monitoring: daftar pemilih yang baru saja memilih (identitas + waktu, TANPA pilihan/paslon - lihat privasi)
router.get('/monitoring/recent-voters', (req, res) => {
  const rows = db.prepare(`
    SELECT 'siswa' AS tipe, nama, kelas AS ket, voted_at FROM students WHERE has_voted = 1
    UNION ALL
    SELECT 'guru' AS tipe, nama, jabatan AS ket, voted_at FROM teachers WHERE has_voted = 1
    ORDER BY voted_at DESC LIMIT 50
  `).all();
  res.json({ ok: true, data: rows });
});

// ================= DATA PEMILIH (CRUD ringan) =================
router.get('/students', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare(`SELECT id, nisn, nama, kelas, jurusan, status, has_voted FROM students
    WHERE nama LIKE ? OR nisn LIKE ? ORDER BY nama ASC LIMIT 500`).all(q, q);
  res.json({ ok: true, data: rows });
});

router.get('/teachers', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare(`SELECT id, nik, nama, nip, jabatan, status, has_voted FROM teachers
    WHERE nama LIKE ? OR nik LIKE ? ORDER BY nama ASC LIMIT 500`).all(q, q);
  res.json({ ok: true, data: rows });
});

router.patch('/students/:id/status', verifyCsrf, (req, res) => {
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  db.prepare(`UPDATE students SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, req.params.id);
  logAudit(req, 'STUDENT_STATUS_UPDATE', `Siswa id=${req.params.id} -> ${status}`, req.session.admin.id);
  res.json({ ok: true });
});

router.patch('/teachers/:id/status', verifyCsrf, (req, res) => {
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
  db.prepare(`UPDATE teachers SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, req.params.id);
  logAudit(req, 'TEACHER_STATUS_UPDATE', `Guru id=${req.params.id} -> ${status}`, req.session.admin.id);
  res.json({ ok: true });
});

router.delete('/students/:id', verifyCsrf, requireSuperAdmin, (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  logAudit(req, 'STUDENT_DELETE', `Siswa id=${req.params.id} dihapus`, req.session.admin.id);
  res.json({ ok: true });
});

router.delete('/teachers/:id', verifyCsrf, requireSuperAdmin, (req, res) => {
  db.prepare('DELETE FROM teachers WHERE id = ?').run(req.params.id);
  logAudit(req, 'TEACHER_DELETE', `Guru id=${req.params.id} dihapus`, req.session.admin.id);
  res.json({ ok: true });
});

// ================= IMPORT DATA PEMILIH =================
router.post('/import/preview', uploadDataFile.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'NO_FILE', message: 'File tidak ditemukan.' });
  const type = req.query.type; // siswa | guru | gabungan

  try {
    if (type === 'siswa') {
      const result = parseSiswaFile(req.file.buffer, req.file.originalname);
      if (result.error) return res.status(400).json({ ok: false, error: 'PARSE_ERROR', message: result.error });
      return res.json({ ok: true, mode: 'siswa', data: result });
    }
    if (type === 'guru') {
      const result = parseGuruFile(req.file.buffer, req.file.originalname);
      if (result.error) return res.status(400).json({ ok: false, error: 'PARSE_ERROR', message: result.error });
      return res.json({ ok: true, mode: 'guru', data: result });
    }
    if (type === 'gabungan') {
      const result = parseGabunganFile(req.file.buffer, req.file.originalname);
      if (result.error) return res.status(400).json({ ok: false, error: 'PARSE_ERROR', message: result.error });
      return res.json({ ok: true, mode: 'gabungan', data: result });
    }
    return res.status(400).json({ ok: false, error: 'INVALID_TYPE', message: 'Parameter type harus siswa|guru|gabungan.' });
  } catch (e) {
    console.error('[IMPORT_PREVIEW_ERROR]', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Gagal membaca file. Pastikan format CSV/XLSX valid.' });
  }
});

router.post('/import/commit', verifyCsrf, (req, res) => {
  const { type, updateExisting, siswaRows, guruRows } = req.body;
  let inserted = 0, updated = 0, skipped = 0;

  const upsertSiswa = db.transaction((rows) => {
    const findStmt = db.prepare('SELECT id FROM students WHERE nisn = ?');
    const insertStmt = db.prepare('INSERT INTO students (nisn, nama, kelas, jurusan) VALUES (?, ?, ?, ?)');
    const updateStmt = db.prepare(`UPDATE students SET nama=?, kelas=?, jurusan=?, updated_at=datetime('now') WHERE nisn=?`);
    for (const r of rows) {
      const existing = findStmt.get(r.nisn);
      if (existing) {
        if (updateExisting) { updateStmt.run(r.nama, r.kelas, r.jurusan, r.nisn); updated++; }
        else skipped++;
      } else {
        insertStmt.run(r.nisn, r.nama, r.kelas, r.jurusan); inserted++;
      }
    }
  });

  const upsertGuru = db.transaction((rows) => {
    const findStmt = db.prepare('SELECT id FROM teachers WHERE nik = ?');
    const insertStmt = db.prepare('INSERT INTO teachers (nik, nama, nip, jabatan) VALUES (?, ?, ?, ?)');
    const updateStmt = db.prepare(`UPDATE teachers SET nama=?, nip=?, jabatan=?, updated_at=datetime('now') WHERE nik=?`);
    for (const r of rows) {
      const existing = findStmt.get(r.nik);
      if (existing) {
        if (updateExisting) { updateStmt.run(r.nama, r.nip, r.jabatan, r.nik); updated++; }
        else skipped++;
      } else {
        insertStmt.run(r.nik, r.nama, r.nip || '', r.jabatan); inserted++;
      }
    }
  });

  try {
    if ((type === 'siswa' || type === 'gabungan') && Array.isArray(siswaRows)) upsertSiswa(siswaRows);
    if ((type === 'guru' || type === 'gabungan') && Array.isArray(guruRows)) upsertGuru(guruRows);
  } catch (e) {
    console.error('[IMPORT_COMMIT_ERROR]', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Gagal menyimpan data import.' });
  }

  logAudit(req, 'IMPORT_DATA_PEMILIH', `type=${type} inserted=${inserted} updated=${updated} skipped=${skipped}`, req.session.admin.id);
  res.json({ ok: true, data: { inserted, updated, skipped } });
});

// ================= CRUD PASLON =================
router.get('/candidates', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates ORDER BY nomor_urut ASC').all();
  res.json({ ok: true, data: rows });
});

router.post('/candidates', verifyCsrf, upload.single('foto'), async (req, res) => {
  try {
    const { nomor_urut, nama_ketua, nama_wakil, visi, misi } = req.body;
    if (!nomor_urut || !nama_ketua) {
      return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Nomor urut dan nama ketua wajib diisi.' });
    }
    let fotoPath = null;
    if (req.file) fotoPath = await processAndSavePhoto(req.file.buffer);

    const info = db.prepare(`
      INSERT INTO candidates (nomor_urut, nama_ketua, nama_wakil, foto, visi, misi, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(Number(nomor_urut), nama_ketua, nama_wakil || '', fotoPath, visi || '', misi || '');

    logAudit(req, 'CANDIDATE_CREATE', `Paslon "${nama_ketua}" dibuat (id=${info.lastInsertRowid})`, req.session.admin.id);
    res.json({ ok: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    console.error('[CANDIDATE_CREATE_ERROR]', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e.message || 'Gagal menyimpan paslon.' });
  }
});

router.put('/candidates/:id', verifyCsrf, upload.single('foto'), async (req, res) => {
  try {
    const { nomor_urut, nama_ketua, nama_wakil, visi, misi, status } = req.body;
    const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    let fotoPath = existing.foto;
    if (req.file) {
      fotoPath = await processAndSavePhoto(req.file.buffer);
      deletePhotoIfExists(existing.foto);
    }

    db.prepare(`
      UPDATE candidates SET nomor_urut=?, nama_ketua=?, nama_wakil=?, foto=?, visi=?, misi=?, status=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      Number(nomor_urut ?? existing.nomor_urut),
      nama_ketua ?? existing.nama_ketua,
      nama_wakil ?? existing.nama_wakil,
      fotoPath,
      visi ?? existing.visi,
      misi ?? existing.misi,
      status ?? existing.status,
      req.params.id
    );

    logAudit(req, 'CANDIDATE_UPDATE', `Paslon id=${req.params.id} diperbarui`, req.session.admin.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[CANDIDATE_UPDATE_ERROR]', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e.message || 'Gagal memperbarui paslon.' });
  }
});

router.delete('/candidates/:id', verifyCsrf, requireSuperAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  // Soft delete: nonaktifkan, JANGAN hard-delete agar riwayat suara (votes.candidate_id) tetap konsisten.
  db.prepare(`UPDATE candidates SET status='inactive', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  logAudit(req, 'CANDIDATE_DEACTIVATE', `Paslon id=${req.params.id} dinonaktifkan`, req.session.admin.id);
  res.json({ ok: true, message: 'Paslon dinonaktifkan (bukan dihapus permanen, agar riwayat suara tetap valid).' });
});

// ================= PENGATURAN PEMILIHAN =================
router.get('/settings', (req, res) => {
  res.json({ ok: true, data: db.prepare('SELECT * FROM election_settings WHERE id = 1').get() });
});

router.put('/settings', verifyCsrf, requireSuperAdmin, (req, res) => {
  const { nama_pemilihan, nama_sekolah, tahun_pelajaran, start_at, end_at, status } = req.body;
  const validStatus = ['belum_dimulai', 'berlangsung', 'selesai'];
  if (status && !validStatus.includes(status)) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });

  db.prepare(`
    UPDATE election_settings SET
      nama_pemilihan = COALESCE(?, nama_pemilihan),
      nama_sekolah = COALESCE(?, nama_sekolah),
      tahun_pelajaran = COALESCE(?, tahun_pelajaran),
      start_at = COALESCE(?, start_at),
      end_at = COALESCE(?, end_at),
      status = COALESCE(?, status),
      updated_at = datetime('now')
    WHERE id = 1
  `).run(nama_pemilihan, nama_sekolah, tahun_pelajaran, start_at, end_at, status);

  logAudit(req, 'SETTINGS_UPDATE', `Pengaturan pemilihan diperbarui (status=${status || 'tidak berubah'})`, req.session.admin.id);
  res.json({ ok: true });
});

// ================= AUDIT LOG =================
router.get('/audit-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare(`
    SELECT al.id, al.action, al.description, al.ip_address, al.created_at, u.username
    FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.id DESC LIMIT ?
  `).all(limit);
  res.json({ ok: true, data: rows });
});

module.exports = router;

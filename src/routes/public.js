const express = require('express');
const db = require('../db/database');
const router = express.Router();

router.get('/settings', (req, res) => {
  const s = db.prepare('SELECT nama_pemilihan, nama_sekolah, tahun_pelajaran, status, start_at, end_at, logo_sekolah FROM election_settings WHERE id = 1').get();
  res.json({ ok: true, data: s });
});

// Realcount publik untuk halaman TV/LCD & landing page. Sengaja TIDAK memuat data identitas pemilih.
router.get('/realcount', (req, res) => {
  const candidates = db.prepare(`
    SELECT c.id, c.nomor_urut, c.nama_ketua, c.nama_wakil, c.foto,
           COALESCE(v.total, 0) AS total_suara
    FROM candidates c
    LEFT JOIN (SELECT candidate_id, COUNT(*) AS total FROM votes GROUP BY candidate_id) v
      ON v.candidate_id = c.id
    WHERE c.status = 'active'
    ORDER BY c.nomor_urut ASC
  `).all();

  const totalSuara = candidates.reduce((sum, c) => sum + c.total_suara, 0);
  const withPercent = candidates.map(c => ({
    ...c,
    persentase: totalSuara > 0 ? Number(((c.total_suara / totalSuara) * 100).toFixed(2)) : 0,
  }));

  const totalPemilihRow = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM students WHERE status='active') +
      (SELECT COUNT(*) FROM teachers WHERE status='active') AS total_pemilih,
      (SELECT COUNT(*) FROM students WHERE status='active' AND has_voted=1) +
      (SELECT COUNT(*) FROM teachers WHERE status='active' AND has_voted=1) AS sudah_memilih
  `).get();

  res.json({
    ok: true,
    data: {
      candidates: withPercent,
      total_suara: totalSuara,
      total_pemilih: totalPemilihRow.total_pemilih,
      sudah_memilih: totalPemilihRow.sudah_memilih,
      updated_at: new Date().toISOString(),
    },
  });
});

module.exports = router;

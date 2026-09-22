const bcrypt = require('bcrypt');
const db = require('./database');

function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',       -- admin | superadmin
    status TEXT NOT NULL DEFAULT 'active',    -- active | disabled
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nisn TEXT UNIQUE NOT NULL,
    nama TEXT NOT NULL,
    kelas TEXT,
    jurusan TEXT,
    status TEXT NOT NULL DEFAULT 'active',    -- active | inactive
    has_voted INTEGER NOT NULL DEFAULT 0,     -- 0/1, hanya boolean, TIDAK menyimpan pilihan
    voted_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nik TEXT UNIQUE NOT NULL,
    nama TEXT NOT NULL,
    nip TEXT,
    jabatan TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    has_voted INTEGER NOT NULL DEFAULT 0,
    voted_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nomor_urut INTEGER NOT NULL,
    nama_ketua TEXT NOT NULL,
    nama_wakil TEXT,
    foto TEXT,
    visi TEXT,
    misi TEXT,
    status TEXT NOT NULL DEFAULT 'active',    -- active | inactive
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- PENTING: tabel votes SENGAJA tidak menyimpan referensi ke voter (students/teachers).
  -- Ini memastikan pilihan tidak bisa ditelusuri balik ke identitas pemilih (lihat README bagian Privasi).
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    voter_type TEXT NOT NULL,                 -- siswa | guru
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS election_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nama_pemilihan TEXT NOT NULL DEFAULT 'Pemilihan Ketua OSIS',
    nama_sekolah TEXT NOT NULL DEFAULT 'SMK Negeri',
    tahun_pelajaran TEXT NOT NULL DEFAULT '2026/2027',
    start_at TEXT,
    end_at TEXT,
    status TEXT NOT NULL DEFAULT 'belum_dimulai', -- belum_dimulai | berlangsung | selesai
    logo_sekolah TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    description TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Rate limiting login percobaan (per identitas) - lapis tambahan selain express-rate-limit per-IP
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL,
    ip_address TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_students_nisn ON students(nisn);
  CREATE INDEX IF NOT EXISTS idx_teachers_nik ON teachers(nik);
  CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_identity_time ON login_attempts(identity, created_at);
  `);

  // Seed election_settings singleton
  const settingsRow = db.prepare('SELECT id FROM election_settings WHERE id = 1').get();
  if (!settingsRow) {
    db.prepare(`INSERT INTO election_settings (id, nama_pemilihan, nama_sekolah, tahun_pelajaran, status)
                VALUES (1, 'Pemilihan Ketua OSIS', 'SMK Negeri (ubah di Pengaturan)', '2026/2027', 'belum_dimulai')`).run();
  }

  // Seed default admin jika belum ada user sama sekali
  const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!anyUser) {
    const defaultPass = process.env.DEFAULT_ADMIN_PASSWORD || 'GantiSegera123!';
    const hash = bcrypt.hashSync(defaultPass, 12);
    db.prepare(`INSERT INTO users (username, password, role, status) VALUES (?, ?, 'superadmin', 'active')`)
      .run(process.env.DEFAULT_ADMIN_USERNAME || 'admin', hash);
    console.log('====================================================');
    console.log(' Akun admin default dibuat:');
    console.log(' username:', process.env.DEFAULT_ADMIN_USERNAME || 'admin');
    console.log(' password:', defaultPass, '(SEGERA GANTI setelah login pertama)');
    console.log('====================================================');
  }
}

module.exports = { initSchema };

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'evoting.db');

const db = new Database(DB_PATH);

// Production-safety pragmas
db.pragma('journal_mode = WAL');     // konkurensi baca/tulis lebih baik, penting untuk anti race-condition
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = db;

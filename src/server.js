require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const { initSchema } = require('./db/init');
const { issueCsrfToken } = require('./middleware/csrf');
const publicRoutes = require('./routes/public');
const authVoterRoutes = require('./routes/authVoter');
const adminRoutes = require('./routes/admin');

initSchema();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Jika di-deploy di belakang reverse proxy (Nginx/Traefik) dengan HTTPS, aktifkan ini via .env
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ---------- SECURITY HEADERS ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- SESSION ----------
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, '..', 'data') }),
  name: 'evoting.sid',
  secret: process.env.SESSION_SECRET || 'GANTI_DENGAN_SECRET_ACAK_DI_ENV_PRODUCTION',
  resave: false,
  saveUninitialized: false,
  rolling: true, // perpanjang masa aktif session setiap ada aktivitas (sliding session timeout)
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION, // WAJIB true di production (butuh HTTPS) - lihat README
    maxAge: 20 * 60 * 1000, // 20 menit
  },
}));

// ---------- STATIC FILES ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ---------- CSRF TOKEN ENDPOINT ----------
app.get('/api/csrf-token', issueCsrfToken);

// ---------- ROUTES ----------
app.use('/api/public', publicRoutes);
app.use('/api/voter', authVoterRoutes);
app.use('/api/admin', adminRoutes);

// ---------- 404 API ----------
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' });
});

// ---------- ERROR HANDLER (multer, dsb.) ----------
app.use((err, req, res, next) => {
  console.error('[UNHANDLED_ERROR]', err);
  const message = err && err.message ? err.message : 'Terjadi kesalahan pada server.';
  res.status(err.status || 400).json({ ok: false, error: 'ERROR', message });
});

app.listen(PORT, () => {
  console.log(`E-Voting OSIS server berjalan di http://localhost:${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV || 'development'}  (secure cookie: ${IS_PRODUCTION})`);
});

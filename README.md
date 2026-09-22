# E-Voting Pemilihan Ketua OSIS

Aplikasi web untuk pelaksanaan pemilihan Ketua OSIS secara online: login siswa (NISN) & guru (NIK/NIP), voting anti-double-vote, realcount live untuk layar TV/LCD, dashboard admin, import DPT massal (CSV/XLSX), dan audit log.

Stack: **Node.js + Express 5 + SQLite (better-sqlite3)**, frontend HTML/JS vanilla + Tailwind (CDN) + Chart.js (CDN). Tidak butuh database server terpisah — cocok untuk deployment di satu server sekolah/lab tanpa infrastruktur tambahan.

---

## 1. Arsitektur

```
┌─────────────┐      HTTPS (Nginx reverse proxy, disarankan)
│  Browser /  │◄───────────────────────────────────┐
│  Layar TV   │                                     │
└─────────────┘                                     │
                                                     ▼
                                          ┌─────────────────────┐
                                          │   Node.js / Express   │
                                          │  (src/server.js)      │
                                          │  - session (cookie)   │
                                          │  - CSRF double-submit │
                                          │  - rate limiting      │
                                          └──────────┬───────────┘
                                                     │
                                          ┌──────────▼───────────┐
                                          │   SQLite (WAL mode)   │
                                          │   data/evoting.db     │
                                          │   data/sessions.sqlite│
                                          └───────────────────────┘
                                                     │
                                          ┌──────────▼───────────┐
                                          │ uploads/photos/*.webp │
                                          └───────────────────────┘
```

Struktur folder penting:
```
src/
  server.js          -> entry point, wiring middleware & routes
  db/init.js         -> skema tabel + seed admin default
  routes/            -> public.js, authVoter.js, admin.js
  middleware/         -> auth.js, csrf.js, rateLimit.js
  utils/              -> importParser.js, photoUpload.js, audit.js
public/               -> semua halaman frontend (statis)
data/                 -> evoting.db, sessions.sqlite (JANGAN di-commit ke git)
uploads/photos/       -> foto paslon hasil upload
```

---

## 2. Prasyarat

- Node.js 18 LTS atau lebih baru (dikembangkan & diuji dengan Node 22)
- npm
- Untuk production: reverse proxy dengan TLS (Nginx/Caddy) — aplikasi ini **tidak** menyediakan HTTPS sendiri

## 3. Instalasi & Menjalankan (Lab / Development)

```bash
npm install
cp .env.example .env
# edit .env: minimal ganti SESSION_SECRET
npm start
```

Server berjalan di `http://localhost:3000`. Saat pertama kali dijalankan (database masih kosong), akun admin default otomatis dibuat dan **dicetak di log terminal**:

```
username: admin
password: GantiSegera123!   <- SEGERA GANTI setelah login pertama (menu Pengaturan)
```

### Verifikasi instalasi berhasil
1. Buka `http://localhost:3000/index.html` → harus tampil landing page dengan status "BELUM DIMULAI".
2. Buka `http://localhost:3000/admin/login.html` → login dengan akun default di atas.
3. Login berhasil → diarahkan ke Dashboard, semua angka menunjukkan 0.

Jika langkah di atas gagal, lihat bagian **Troubleshooting**.

---

## 4. Alur Kerja Standar (untuk panitia pemilihan)

1. **Pengaturan** → isi nama sekolah, nama pemilihan, tahun pelajaran. Status tetap "Belum Dimulai".
2. **Paslon** → tambahkan minimal 2 paslon (nomor urut, nama ketua/wakil, foto, visi/misi).
3. **Import Data** → upload file DPT:
   - Jika file terpisah per jenis (siswa/guru) dengan header `NISN|Nama|Kelas|Jurusan` atau `NIK|Nama|NIP|Jabatan`, pilih mode **IMPORT DATA SISWA** / **IMPORT DATA GURU**.
   - Jika file berupa satu sheet gabungan (format `NO, NAMA, NISN/NIK, KELAS/jabatan` — seperti file DPT yang pernah diberikan), pilih mode **FORMAT GABUNGAN (Auto-Deteksi)**.
   - Selalu cek pratinjau (jumlah valid/invalid, baris bermasalah) sebelum klik "Konfirmasi & Simpan".
4. Saat hari-H, ubah **Status Pemilihan** menjadi "Sedang Berlangsung" di menu Pengaturan. Login siswa/guru hanya diterima saat status ini aktif.
5. Tampilkan `/realcount.html` di layar TV/LCD (auto-refresh 10 detik, tanpa reload).
6. Setelah selesai, ubah status ke "Selesai" agar login pemilih otomatis ditolak.

---

## 5. Catatan Verifikasi (berdasarkan file `daftar_pemilih_tetap.xlsx` yang diberikan)

Beberapa hal berikut **perlu dikonfirmasi ke panitia sebelum dipakai di hari-H**, bukan diasumsikan sebagai fakta final:

- `[PERLU VERIFIKASI]` Kolom "NISN/NIK" pada file gabungan berisi angka **18 digit** untuk guru/staf (pola mirip NIP, mis. `197007141995122003`), **bukan NIK KTP 16 digit**. Mode auto-deteksi tetap memprosesnya sebagai identitas login guru apa adanya. Jika sekolah memang bermaksud memakai NIK KTP asli untuk login guru (bukan NIP), data ini perlu diganti terlebih dahulu sebelum import — NIK adalah data yang jauh lebih sensitif daripada NIP dan konsekuensi kebocorannya berbeda.
- `[ASUMSI]` Kolom "KELAS/jabatan" dipisah dengan aturan: token pertama (dipisah spasi) = kelas (mis. "XI", "XII", "X"), sisanya = jurusan. Sudah diuji cocok dengan seluruh 103 baris siswa di file yang diberikan (0 baris invalid), tetapi jika ada singkatan jurusan yang mengandung spasi (misal "AKUNTANSI LEMBAGA"), cek ulang hasil pratinjau sebelum commit.
- `[ASUMSI]` Baris dengan jabatan seperti "Wakasek Kurikulum", "Kaprodi Tekstil" dianggap sebagai pemilih kategori "guru" (memilih via NIK/identitas staf), bukan siswa. Sesuai spesifikasi awal Anda, ini benar (guru & staf sama-sama masuk kategori pemilih guru).

---

## 6. Keamanan yang Sudah Diimplementasikan

| Aspek | Implementasi |
|---|---|
| Session | `express-session` + `connect-sqlite3` (persisten, bertahan restart), cookie `HttpOnly`, `SameSite=Strict`, `secure=true` otomatis saat `NODE_ENV=production` |
| Session fixation | `session.regenerate()` setiap login (admin & voter) |
| CSRF | Double-submit token (`X-CSRF-Token` header vs `session.csrfToken`), wajib di semua request state-changing |
| Rate limiting | Lapis 1: per-IP (`express-rate-limit`). Lapis 2: per-identitas (NISN/NIK/username) tersimpan di tabel `login_attempts`, lockout 15 menit setelah 5 (voter) / 8 (admin) percobaan gagal |
| Password admin | `bcrypt` cost factor 12 |
| Anti double-voting | Transaksi sinkron `db.transaction()`: `UPDATE ... SET has_voted=1 WHERE id=? AND has_voted=0` — hanya 1 request yang bisa mengubah baris dari 0→1. SQLite juga hanya mengizinkan satu writer aktif pada satu waktu (WAL mode), jadi ini aman bahkan lintas proses, bukan hanya lintas request dalam proses yang sama. |
| Privasi pilihan | Tabel `votes` **tidak menyimpan referensi ke voter** (tidak ada kolom voter_id) — sudah diverifikasi langsung dari isi database saat testing. Audit log hanya mencatat "siswa/guru id=X telah memilih", TIDAK mencatat paslon yang dipilih. |
| Upload foto | Validasi ulang via `sharp` (bukan hanya percaya mimetype header), resize maks 800x800, kompresi ke WebP, nama file diacak (bukan nama asli) |
| Import file | Validasi header, deteksi duplikat di dalam file, preview wajib sebelum commit ke database |
| Security headers | `helmet` (CSP membatasi script hanya dari domain sendiri + cdn.tailwindcss.com + cdnjs.cloudflare.com) |

### Yang SENGAJA belum/tidak diimplementasikan (batasan jujur, bukan disembunyikan)

- **HTTPS/TLS**: aplikasi ini adalah aplikasi Node polos. Untuk production, **wajib** taruh di belakang reverse proxy (Nginx/Caddy) dengan sertifikat TLS (Let's Encrypt), lalu set `TRUST_PROXY=true` dan `NODE_ENV=production` di `.env`. Tanpa HTTPS, cookie session tidak akan dikirim browser (karena `secure=true`) dan seluruh proteksi CSRF/session tidak berarti banyak karena trafik bisa disadap.
- **Multi-instance / clustering**: garansi anti-double-vote di atas berlaku untuk **satu proses Node** membaca satu file SQLite. Jika di-deploy dengan PM2 cluster mode atau banyak instance di belakang load balancer, SQLite tetap melindungi dari race condition write (single-writer lock), tapi throughput akan jadi bottleneck di volume sangat tinggi. Untuk skala > beberapa ribu pemilih serentak, pertimbangkan migrasi ke PostgreSQL dengan `SELECT ... FOR UPDATE`.
- **Manajemen banyak admin**: saat ini hanya 1 akun admin (superadmin) yang di-seed otomatis. Endpoint untuk membuat admin tambahan belum dibuat di UI (tabel `users` sudah mendukung banyak admin dengan role, tinggal ditambahkan endpoint CRUD jika dibutuhkan).
- **Backup otomatis**: tidak ada job backup bawaan. Backup = Snapshot = Replication adalah hal berbeda (lihat preferensi Anda) — untuk pemilihan sungguhan, minimal lakukan `cp data/evoting.db data/evoting-backup-$(date +%F).db` secara berkala selama masa voting berlangsung, dan uji proses restore-nya, bukan cuma menyalin file.

---

## 7. Perbedaan Konfigurasi: Lab vs Production

| | Lab / Uji Coba | Production (hari-H sungguhan) |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| HTTPS | Opsional | **Wajib** (reverse proxy + Let's Encrypt) |
| `SESSION_SECRET` | boleh default | **Wajib** diganti (`openssl rand -hex 32`) |
| `TRUST_PROXY` | `false` | `true` (jika di belakang Nginx) |
| Password admin default | boleh dibiarkan sementara | **Wajib** diganti sebelum data pemilih diimport |
| Backup DB | tidak perlu | Backup manual berkala selama masa voting + setelah voting selesai |
| Jumlah proses | 1 proses `node` cukup | 1 proses `node` (jangan cluster mode kecuali migrasi ke Postgres) di belakang Nginx sebagai reverse proxy + static file caching |

---

## 8. Troubleshooting

| Gejala | Kemungkinan Penyebab | Cara Cek |
|---|---|---|
| `CSRF_INVALID` terus-menerus | Cookie session tidak terkirim (mode private browsing yang keras, atau domain/protokol beda antara frontend & API) | Cek DevTools → Application → Cookies, pastikan `evoting.sid` ada dan tidak `Secure` saat masih HTTP |
| Foto paslon gagal upload | File > 3MB atau bukan JPG/PNG/WEBP | Cek pesan error di response, kompres/convert dulu |
| Import ditolak "Header wajib tidak ditemukan" | Nama kolom header tidak cocok (case-insensitive tapi ejaan harus sama) | Gunakan template yang disediakan di halaman Import |
| Siswa/guru tidak bisa login walau data ada | Status pemilihan bukan "berlangsung", atau status data pemilih "inactive" | Cek menu Pengaturan & Data Pemilih |
| Server tidak jalan setelah `npm install` | Modul native (`better-sqlite3`, `sharp`) gagal build di OS/arsitektur tertentu | Jalankan `npm rebuild better-sqlite3 sharp`, pastikan versi Node kompatibel |

Command diagnosis dulu, baru command perubahan:
```bash
# 1. Cek proses & log
ps aux | grep node
tail -f /var/log/evoting/server.log   # sesuaikan lokasi log Anda

# 2. Cek isi database (read-only, aman)
node -e "const db=require('./src/db/database'); console.log(db.prepare('SELECT status FROM election_settings').get())"

# 3. Baru lakukan perubahan (mis. restart service)
pm2 restart evoting-osis   # atau systemctl restart evoting-osis
```

---

## 9. Deployment Sederhana dengan PM2 + Nginx (contoh, sesuaikan dengan environment Anda)

```bash
npm install -g pm2
pm2 start src/server.js --name evoting-osis
pm2 save
pm2 startup   # ikuti instruksi yang ditampilkan
```

Contoh reverse proxy Nginx (ringkas — sesuaikan hardening TLS/header sesuai kebijakan Anda):
```nginx
server {
    listen 443 ssl http2;
    server_name evoting.sekolah.sch.id;
    ssl_certificate     /etc/letsencrypt/live/evoting.sekolah.sch.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/evoting.sekolah.sch.id/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Jangan lupa set `TRUST_PROXY=true` di `.env` agar `req.ip` (dipakai rate limiting) membaca IP asli dari header `X-Forwarded-For`, bukan IP Nginx.

---

## 10. Lisensi & Catatan

Dibuat sebagai proyek internal sekolah. Tidak ada dependensi berbayar. Semua library pihak ketiga (Express, better-sqlite3, bcrypt, sharp, dll.) adalah open source dengan lisensi MIT/ISC — cek `package.json` untuk daftar lengkap.

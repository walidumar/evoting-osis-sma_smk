const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'photos');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 3 * 1024 * 1024; // 3MB batas upload mentah sebelum kompresi

// Simpan sementara di memory, validasi dulu, baru ditulis ke disk dengan nama aman (bukan nama asli user)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Format file tidak didukung. Gunakan JPG, JPEG, PNG, atau WEBP.'));
    }
    cb(null, true);
  },
});

// Proses: validasi ulang via sharp (memastikan file benar-benar gambar valid, bukan hanya klaim mimetype),
// resize max 800x800, kompresi ke webp kualitas 82%, nama file acak.
async function processAndSavePhoto(fileBuffer) {
  const safeName = crypto.randomBytes(16).toString('hex') + '.webp';
  const destPath = path.join(UPLOAD_DIR, safeName);

  await sharp(fileBuffer)
    .rotate() // auto-orient berdasarkan EXIF
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(destPath);

  return `/uploads/photos/${safeName}`;
}

function deletePhotoIfExists(publicPath) {
  if (!publicPath) return;
  const filename = path.basename(publicPath);
  const fullPath = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

// Multer terpisah khusus untuk upload file data pemilih (CSV/XLSX) - fileFilter berbeda dari foto paslon.
const uploadDataFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, DPT bisa ribuan baris
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      return cb(new Error('Format file tidak didukung. Gunakan CSV atau XLSX.'));
    }
    cb(null, true);
  },
});

module.exports = { upload, uploadDataFile, processAndSavePhoto, deletePhotoIfExists, UPLOAD_DIR };

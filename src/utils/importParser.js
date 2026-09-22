const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

function normalizeHeader(h) {
  return String(h || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Baca file (buffer) -> array of array (baris mentah, baris 1 = header)
function readSheetAsRows(buffer, originalFilename) {
  const ext = (originalFilename.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') {
    const text = buffer.toString('utf8');
    const records = csvParse(text, { skip_empty_lines: true, relax_column_count: true, bom: true });
    return records;
  }
  // xlsx / xls
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  return rows;
}

function findColIndex(headerRow, candidates) {
  const norm = headerRow.map(normalizeHeader);
  for (const cand of candidates) {
    const idx = norm.indexOf(normalizeHeader(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

function isDigitsOnly(v) {
  return /^\d+$/.test(String(v || '').trim());
}

/**
 * Parse & validasi file data SISWA. Header yang diterima (fleksibel urutan & huruf besar/kecil):
 * NISN | Nama | Kelas | Jurusan
 */
function parseSiswaFile(buffer, originalFilename) {
  const rows = readSheetAsRows(buffer, originalFilename);
  if (rows.length === 0) return { error: 'File kosong.' };
  const header = rows[0];

  const idxNisn = findColIndex(header, ['NISN']);
  const idxNama = findColIndex(header, ['NAMA', 'NAMA SISWA']);
  const idxKelas = findColIndex(header, ['KELAS']);
  const idxJurusan = findColIndex(header, ['JURUSAN']);

  if (idxNisn === -1 || idxNama === -1) {
    return { error: 'Header wajib tidak ditemukan. Minimal kolom "NISN" dan "Nama" harus ada. Gunakan template yang disediakan.' };
  }

  return validateAndDedupe(rows.slice(1), (row, rowNumber) => {
    const nisn = String(row[idxNisn] ?? '').trim();
    const nama = String(row[idxNama] ?? '').trim();
    const kelas = idxKelas !== -1 ? String(row[idxKelas] ?? '').trim() : '';
    const jurusan = idxJurusan !== -1 ? String(row[idxJurusan] ?? '').trim() : '';

    const errors = [];
    if (!nisn) errors.push('NISN kosong');
    else if (!isDigitsOnly(nisn)) errors.push('NISN harus berupa angka');
    else if (nisn.length < 8 || nisn.length > 15) errors.push('Panjang NISN tidak wajar (cek data)');
    if (!nama) errors.push('Nama kosong');

    return { rowNumber, key: nisn, data: { nisn, nama, kelas, jurusan }, errors };
  });
}

/**
 * Parse & validasi file data GURU. Header:
 * NIK | Nama | NIP | Jabatan
 */
function parseGuruFile(buffer, originalFilename) {
  const rows = readSheetAsRows(buffer, originalFilename);
  if (rows.length === 0) return { error: 'File kosong.' };
  const header = rows[0];

  const idxNik = findColIndex(header, ['NIK']);
  const idxNama = findColIndex(header, ['NAMA', 'NAMA GURU']);
  const idxNip = findColIndex(header, ['NIP']);
  const idxJabatan = findColIndex(header, ['JABATAN']);

  if (idxNik === -1 || idxNama === -1) {
    return { error: 'Header wajib tidak ditemukan. Minimal kolom "NIK" dan "Nama" harus ada. Gunakan template yang disediakan.' };
  }

  return validateAndDedupe(rows.slice(1), (row, rowNumber) => {
    const nik = String(row[idxNik] ?? '').trim();
    const nama = String(row[idxNama] ?? '').trim();
    const nip = idxNip !== -1 ? String(row[idxNip] ?? '').trim() : '';
    const jabatan = idxJabatan !== -1 ? String(row[idxJabatan] ?? '').trim() : '';

    const errors = [];
    if (!nik) errors.push('NIK kosong');
    else if (!isDigitsOnly(nik)) errors.push('NIK harus berupa angka');
    else if (nik.length < 6 || nik.length > 20) errors.push('Panjang NIK/NIP tidak wajar (cek data)');
    if (!nama) errors.push('Nama kosong');

    return { rowNumber, key: nik, data: { nik, nama, nip, jabatan }, errors };
  });
}

/**
 * Mode "Gabungan / Auto-Deteksi": untuk file DPT lama dengan format
 * NO | NAMA | NISN/NIK | KELAS/jabatan (satu sheet berisi guru & siswa sekaligus).
 * Heuristik: panjang angka identitas <= 10 digit -> siswa (NISN),
 * lebih panjang (biasanya 18 digit gaya NIP) -> guru/staff.
 * [ASUMSI - PERLU VERIFIKASI]: kolom identitas guru pada file gabungan umumnya berisi
 * NIP (18 digit), BUKAN NIK KTP 16 digit. Jika sekolah memang ingin login guru
 * memakai NIK KTP asli, data ini perlu disandingkan/diganti terlebih dahulu.
 */
function parseGabunganFile(buffer, originalFilename) {
  const rows = readSheetAsRows(buffer, originalFilename);
  if (rows.length === 0) return { error: 'File kosong.' };
  const header = rows[0];

  const idxNama = findColIndex(header, ['NAMA']);
  const idxId = findColIndex(header, ['NISN/NIK', 'NISN / NIK', 'NIK/NISN']);
  const idxKelasJabatan = findColIndex(header, ['KELAS/JABATAN', 'KELAS/jabatan'.toUpperCase(), 'KELAS / JABATAN']);

  if (idxNama === -1 || idxId === -1 || idxKelasJabatan === -1) {
    return { error: 'Format gabungan tidak dikenali. Header yang diharapkan: NO, NAMA, NISN/NIK, KELAS/jabatan.' };
  }

  const siswaRows = [];
  const guruRows = [];
  const gradePattern = /^(X{1,3}I{0,3}|X)\b/i; // X, XI, XII di awal teks

  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2;
    const nama = String(row[idxNama] ?? '').trim();
    const idVal = String(row[idxId] ?? '').trim();
    const kelasJabatan = String(row[idxKelasJabatan] ?? '').trim();
    if (!nama && !idVal) return; // baris kosong, lewati

    const looksLikeStudentClass = gradePattern.test(kelasJabatan);
    const isShortId = isDigitsOnly(idVal) && idVal.length <= 12;

    if (looksLikeStudentClass || isShortId) {
      const parts = kelasJabatan.split(/\s+/);
      const kelas = parts.shift() || '';
      const jurusan = parts.join(' ');
      siswaRows.push({ rowNumber, idVal, nama, kelas, jurusan });
    } else {
      guruRows.push({ rowNumber, idVal, nama, jabatan: kelasJabatan });
    }
  });

  const siswaResult = validateAndDedupe(
    siswaRows.map(r => [r.idVal, r.nama, r.kelas, r.jurusan]),
    (row, rowNumber) => {
      const [nisn, nama, kelas, jurusan] = row;
      const errors = [];
      if (!nisn) errors.push('NISN kosong');
      else if (!isDigitsOnly(nisn)) errors.push('NISN harus angka');
      if (!nama) errors.push('Nama kosong');
      return { rowNumber, key: nisn, data: { nisn, nama, kelas, jurusan }, errors };
    },
    siswaRows.map(r => r.rowNumber)
  );

  const guruResult = validateAndDedupe(
    guruRows.map(r => [r.idVal, r.nama, r.jabatan]),
    (row, rowNumber) => {
      const [nik, nama, jabatan] = row;
      const errors = [];
      if (!nik) errors.push('NIK/NIP kosong');
      else if (!isDigitsOnly(nik)) errors.push('NIK/NIP harus angka');
      if (!nama) errors.push('Nama kosong');
      return { rowNumber, key: nik, data: { nik, nama, nip: '', jabatan }, errors };
    },
    guruRows.map(r => r.rowNumber)
  );

  return { siswa: siswaResult, guru: guruResult };
}

// Helper umum: jalankan validator per baris, deteksi duplikat KEY di dalam file itu sendiri
function validateAndDedupe(dataRows, rowValidator, rowNumbers) {
  const seen = new Map();
  const validRows = [];
  const invalidRows = [];

  dataRows.forEach((row, i) => {
    const rowNumber = rowNumbers ? rowNumbers[i] : i + 2;
    const result = rowValidator(row, rowNumber);
    if (result.errors.length > 0) {
      invalidRows.push({ rowNumber, data: result.data, errors: result.errors });
      return;
    }
    if (seen.has(result.key)) {
      invalidRows.push({ rowNumber, data: result.data, errors: [`Duplikat di dalam file (identitas sama dengan baris ${seen.get(result.key)})`] });
      return;
    }
    seen.set(result.key, rowNumber);
    validRows.push(result.data);
  });

  return {
    totalRows: dataRows.length,
    validCount: validRows.length,
    invalidCount: invalidRows.length,
    validRows,
    invalidRows,
  };
}

module.exports = { parseSiswaFile, parseGuruFile, parseGabunganFile };

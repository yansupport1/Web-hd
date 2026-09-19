# Jernih

Web untuk meng-HD-kan foto dan video dengan tiga pilihan kualitas.

| Pilihan | Cara kerja |
|---|---|
| HD biasa | ffmpeg di server: sisi terpendek jadi 1080 px, Lanczos + penajaman |
| UHD | ffmpeg di server: sisi terpendek jadi 2160 px (4K), tanpa detail baru |
| HD asli | Real-ESRGAN lewat API Replicate: detail dipulihkan oleh AI |

Server memakai modul bawaan Node saja. Satu-satunya paket tambahan adalah
`ffmpeg-static`, supaya kamu tidak perlu memasang ffmpeg sendiri.

## Menjalankan

1. Pasang Node.js 18 atau lebih baru (https://nodejs.org).
2. Ekstrak zip ini, buka terminal di foldernya, lalu jalankan:

```bash
npm install
npm start
```

3. Buka http://localhost:3000, seret foto atau video ke kotak unggah, pilih
   kualitas, klik **Tingkatkan kualitas**, lalu klik **Unduh hasil**.

HD biasa dan UHD langsung jalan tanpa pengaturan apa pun.

## Mengaktifkan HD asli (AI)

1. Buat akun di https://replicate.com, lalu buat token di
   https://replicate.com/account/api-tokens
2. Salin `.env.example` menjadi `.env` dan isi `REPLICATE_API_TOKEN=token_kamu`
3. Jalankan ulang `npm start`

Setelah token terisi, pilihan HD asli otomatis aktif.

## Struktur

- `server.js`: unggahan, ffmpeg, pemanggilan API Replicate, status tugas
- `index.html`: tampilan web (satu berkas)
- `.env.example`: contoh pengaturan

## Catatan

- API key hanya ada di server (`.env`), tidak pernah dikirim ke browser.
- Nama input model AI ada di fungsi `startAI` di `server.js`
  (`image`, `scale`, `face_enhance` untuk foto; `video_path`, `resolution` untuk video).
  Kalau kamu mengganti `MODEL_IMAGE` atau `MODEL_VIDEO`, cocokkan nama inputnya
  dengan halaman model di Replicate.
- Batas unggah bawaan 100 MB (`MAX_UPLOAD_MB` di `.env`). Berkas diproses di memori
  server, jadi jangan diset terlalu besar.
- Sebelum dibuka untuk umum, tambahkan login dan batas pemakaian. Setiap proses
  HD asli dikenakan biaya ke akun Replicate kamu.
- Berkas sementara dihapus otomatis setelah 1 jam.
- Foto HEIC dari iPhone kadang tidak terbaca. Ekspor ke JPG dulu kalau muncul galat.

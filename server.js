'use strict';
/*
 * Jernih: server tanpa dependensi (hanya modul bawaan Node 18+).
 * - HD biasa dan UHD: ffmpeg
 * - HD asli: API Replicate (Real-ESRGAN)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

/* ---------- Konfigurasi (.env) ---------- */

try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.REPLICATE_API_TOKEN || '';
const MODEL_IMAGE = process.env.MODEL_IMAGE || 'nightmareai/real-esrgan';
const MODEL_VIDEO = process.env.MODEL_VIDEO || 'lucataco/real-esrgan-video';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const RP = process.env.REPLICATE_API_BASE || 'https://api.replicate.com/v1';

let FFMPEG = 'ffmpeg';
try {
  FFMPEG = require('ffmpeg-static') || 'ffmpeg';
} catch {}

const UPLOAD_DIR = path.join(__dirname, 'tmp', 'uploads');
const OUT_DIR = path.join(__dirname, 'tmp', 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// id tugas -> { id, status: 'processing' | 'done' | 'error', isVideo, url, error, replicateId }
const jobs = new Map();

/* ---------- Bantuan HTTP ---------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error('LIMIT')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const fields = {};
  let file = null;
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const hdrEnd = buf.indexOf('\r\n\r\n', start);
    if (hdrEnd === -1) break;
    const header = buf.slice(start + 2, hdrEnd).toString('utf8');
    const next = buf.indexOf(delim, hdrEnd + 4);
    if (next === -1) break;
    const data = buf.slice(hdrEnd + 4, next - 2);
    const name = (/name="([^"]*)"/.exec(header) || [])[1];
    const isFile = /filename="/.test(header);
    if (isFile) {
      const ct = /content-type:\s*([^\r\n]+)/i.exec(header);
      const fn = (/filename="([^"]*)"/.exec(header) || [])[1] || 'berkas';
      file = { field: name, filename: fn, mimetype: ct ? ct[1].trim().toLowerCase() : 'application/octet-stream', data };
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

function serveOutput(req, res, rawName) {
  const name = path.basename(decodeURIComponent(rawName));
  if (!/^[\w-]+\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i.test(name)) return json(res, 404, { error: 'Tidak ditemukan.' });
  const p = path.join(OUT_DIR, name);
  let st;
  try { st = fs.statSync(p); } catch { return json(res, 404, { error: 'Berkas sudah dihapus atau tidak ada.' }); }
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let a = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let b = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(p, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
  fs.createReadStream(p).pipe(res);
}

/* ---------- ffmpeg (HD biasa dan UHD) ---------- */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let log = '';
    p.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
    p.on('error', () => reject(new Error('ffmpeg tidak ditemukan. Jalankan "npm install" atau pasang ffmpeg.')));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      console.error('ffmpeg gagal:', log.trim().split('\n').slice(-3).join(' | '));
      reject(new Error('Berkas ini tidak bisa diproses. Pastikan formatnya foto atau video yang valid.'));
    });
  });
}

// Sisi terpendek diskalakan ke `target` piksel, lalu dipertajam sedikit.
function buildArgs(input, output, isVideo, target) {
  const vf =
    `scale=w='if(lt(iw,ih),${target},-2)':h='if(lt(iw,ih),-2,${target})':flags=lanczos,` +
    `unsharp=5:5:0.8:5:5:0.0`;
  if (!isVideo) {
    const q = output.endsWith('.jpg') ? ['-q:v', '2'] : [];
    return ['-y', '-i', input, '-vf', vf, '-frames:v', '1', ...q, output];
  }
  return [
    '-y', '-i', input,
    '-vf', vf,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
}

/* ---------- Replicate (HD asli dengan AI) ---------- */

async function rp(pathname, opts = {}) {
  const r = await fetch(RP + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { detail: text }; }
  if (!r.ok) throw new Error(data.detail || data.title || `Replicate error ${r.status}`);
  return data;
}

async function uploadToReplicate(buf, name, mime) {
  const form = new FormData();
  form.append('content', new Blob([buf], { type: mime }), name);
  const data = await rp('/files', { method: 'POST', body: form });
  return data.urls.get;
}

const versionCache = new Map();
async function resolveVersion(model) {
  if (model.includes(':')) return model.split(':')[1];
  if (versionCache.has(model)) return versionCache.get(model);
  const m = await rp(`/models/${model}`);
  const v = m.latest_version && m.latest_version.id;
  if (!v) throw new Error('Model tidak ditemukan di Replicate: ' + model);
  versionCache.set(model, v);
  return v;
}

async function startAI(job, file, fields) {
  const fileUrl = await uploadToReplicate(file.data, file.filename, file.mimetype);
  let input;
  if (job.isVideo) {
    const res = ['FHD', '2k', '4k'].includes(fields.resolution) ? fields.resolution : 'FHD';
    input = { video_path: fileUrl, resolution: res };
  } else {
    const scale = Number(fields.scale) === 2 ? 2 : 4;
    input = { image: fileUrl, scale, face_enhance: fields.face === 'true' };
  }
  const version = await resolveVersion(job.isVideo ? MODEL_VIDEO : MODEL_IMAGE);
  const pred = await rp('/predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, input }),
  });
  job.replicateId = pred.id;
}

async function finalizeAI(job, outUrl) {
  if (job.finalizing) return job.finalizing;
  job.finalizing = (async () => {
    const r = await fetch(outUrl);
    if (!r.ok) throw new Error('Gagal mengambil hasil dari Replicate.');
    let ext = path.extname(new URL(outUrl).pathname).toLowerCase();
    if (!MIME[ext]) ext = job.isVideo ? '.mp4' : '.png';
    const name = job.id + ext;
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(path.join(OUT_DIR, name)));
    job.url = '/files/' + name;
    job.status = 'done';
  })();
  return job.finalizing;
}

/* ---------- Rute ---------- */

async function enhance(req, res) {
  const ctype = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!/multipart\/form-data/i.test(ctype) || !bm) return json(res, 400, { error: 'Permintaan tidak valid.' });

  let body;
  try {
    body = await readBody(req, (MAX_MB + 1) * 1048576);
  } catch {
    return json(res, 413, { error: `Berkas terlalu besar. Maksimal ${MAX_MB} MB.` });
  }
  const { fields, file } = parseMultipart(body, bm[1] || bm[2]);
  if (!file || !file.data.length) return json(res, 400, { error: 'Berkas belum dipilih.' });
  if (file.data.length > MAX_MB * 1048576) return json(res, 413, { error: `Berkas terlalu besar. Maksimal ${MAX_MB} MB.` });
  // Tipe berkas diambil dari mimetype, atau dari ekstensi kalau browser tidak mengirim tipe yang jelas.
  const ext0 = path.extname(file.filename).toLowerCase();
  let kind = null;
  if (file.mimetype.startsWith('video/')) kind = 'video';
  else if (file.mimetype.startsWith('image/')) kind = 'image';
  else if (/^\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/.test(ext0)) kind = 'video';
  else if (/^\.(jpe?g|png|webp|gif|bmp|tiff?)$/.test(ext0)) kind = 'image';
  if (!kind) return json(res, 400, { error: 'Format tidak didukung. Gunakan foto atau video.' });
  if (!/^(image|video)\//.test(file.mimetype)) file.mimetype = MIME[ext0] || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const mode = fields.mode;
  if (!['hd', 'uhd', 'ai'].includes(mode)) return json(res, 400, { error: 'Mode tidak valid.' });

  const isVideo = kind === 'video';
  const id = crypto.randomUUID();
  const job = { id, status: 'processing', isVideo, createdAt: Date.now() };
  jobs.set(id, job);

  try {
    if (mode === 'ai') {
      if (!TOKEN) throw new Error('REPLICATE_API_TOKEN belum diisi di file .env.');
      await startAI(job, file, fields);
    } else {
      const target = mode === 'hd' ? 1080 : 2160;
      const asPng = !isVideo && /png|webp|gif|bmp|tiff/.test(file.mimetype + ext0);
      const ext = isVideo ? '.mp4' : asPng ? '.png' : '.jpg';
      const inPath = path.join(UPLOAD_DIR, id);
      const outPath = path.join(OUT_DIR, id + ext);
      await fs.promises.writeFile(inPath, file.data);
      runFfmpeg(buildArgs(inPath, outPath, isVideo, target))
        .then(() => { job.status = 'done'; job.url = '/files/' + id + ext; })
        .catch((e) => { job.status = 'error'; job.error = e.message; })
        .finally(() => fs.unlink(inPath, () => {}));
    }
    json(res, 200, { id });
  } catch (e) {
    jobs.delete(id);
    json(res, 500, { error: e.message });
  }
}

async function jobStatus(res, id) {
  const job = jobs.get(id);
  if (!job) return json(res, 404, { status: 'error', error: 'Tugas tidak ditemukan.' });

  if (job.status === 'processing' && job.replicateId) {
    try {
      const p = await rp('/predictions/' + job.replicateId);
      if (p.status === 'succeeded') {
        const out = Array.isArray(p.output) ? p.output[0] : p.output;
        await finalizeAI(job, out);
      } else if (p.status === 'failed' || p.status === 'canceled') {
        job.status = 'error';
        job.error = p.error || 'Pemrosesan AI gagal.';
      }
    } catch (e) {
      job.pollErrors = (job.pollErrors || 0) + 1;
      if (job.pollErrors > 5) { job.status = 'error'; job.error = e.message; }
    }
  }
  json(res, 200, { status: job.status, url: job.url, error: job.error });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ai: Boolean(TOKEN), maxMb: MAX_MB });
    if (req.method === 'POST' && url.pathname === '/api/enhance') return await enhance(req, res);
    let m = req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (m) return await jobStatus(res, m[1]);
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) return serveOutput(req, res, url.pathname.slice(7));
    json(res, 404, { error: 'Tidak ditemukan.' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

/* ---------- Bersih-bersih berkas sementara (usia > 1 jam) ---------- */

setInterval(() => {
  const limit = Date.now() - 60 * 60 * 1000;
  for (const dir of [UPLOAD_DIR, OUT_DIR]) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch {}
    }
  }
  for (const [id, job] of jobs) if (job.createdAt < limit) jobs.delete(id);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Jernih jalan di http://localhost:${PORT}`));

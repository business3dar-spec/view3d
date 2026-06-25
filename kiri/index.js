// kiri/index.js
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Wrapper around the KIRI Engine API (https://docs.kiriengine.app).
//
// Flow used by this app:
//   1. uploadPhotoSet()  -> sends captured photos, gets back a `serialize` job id
//   2. pollUntilDone()   -> repeatedly checks status until success/failed/expired
//   3. downloadAndSaveGlb() -> downloads the result zip, extracts the .glb,
//                              saves it into /uploads/models, returns its public URL
//
// Requires KIRI_API_KEY in the environment. If it's missing, every function
// returns { ok:false } with a clear reason instead of crashing.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const extractZip = require('extract-zip');

const KIRI_BASE = 'https://api.kiriengine.app/api/v1/open';

function isConfigured() {
  return !!process.env.KIRI_API_KEY;
}

function authHeader() {
  return { Authorization: `Bearer ${process.env.KIRI_API_KEY}` };
}

// Uploads a set of photo file paths to KIRI and returns the job's serialize ID.
async function uploadPhotoSet(imagePaths) {
  if (!isConfigured()) return { ok: false, reason: 'KIRI_API_KEY not set' };
  if (!imagePaths || imagePaths.length < 20) {
    return { ok: false, reason: `KIRI requires at least 20 photos (got ${imagePaths ? imagePaths.length : 0})` };
  }

  try {
    const form = new FormData();
    imagePaths.forEach(p => form.append('imagesFiles', fs.createReadStream(p)));
    form.append('modelQuality', '0');     // 0 = High
    form.append('textureQuality', '0');   // 0 = 4K
    form.append('fileFormat', 'GLB');
    form.append('isMask', '1');           // auto object masking on â€” crops background
    form.append('textureSmoothing', '0');

    const res = await axios.post(`${KIRI_BASE}/photo/image`, form, {
      headers: { ...form.getHeaders(), ...authHeader() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    if (res.data && res.data.ok) {
      return { ok: true, serialize: res.data.data.serialize };
    }
    return { ok: false, reason: res.data?.msg || 'Upload failed' };
  } catch (err) {
    return { ok: false, reason: err.response?.data?.msg || err.message };
  }
}

const STATUS_MAP = { '-1': 'uploading', '0': 'processing', '1': 'failed', '2': 'success', '3': 'queuing', '4': 'expired' };

// Single status check.
async function getStatus(serialize) {
  if (!isConfigured()) return { ok: false, reason: 'KIRI not configured' };
  try {
    const res = await axios.get(`${KIRI_BASE}/model/getStatus`, {
      params: { serialize },
      headers: authHeader()
    });
    const code = String(res.data?.data?.status);
    return { ok: true, status: STATUS_MAP[code] || 'unknown', raw: code };
  } catch (err) {
    return { ok: false, reason: err.response?.data?.msg || err.message };
  }
}

// Polls every `intervalMs` until success/failed/expired, or `maxWaitMs` elapses.
// KIRI processing can genuinely take 20-40+ minutes for high-quality scans,
// so this defaults to a generous 45 minutes rather than failing prematurely.
async function pollUntilDone(serialize, intervalMs = 15000, maxWaitMs = 45 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await getStatus(serialize);
    if (!result.ok) return result;
    if (result.status === 'success') return { ok: true, status: 'success' };
    if (result.status === 'failed' || result.status === 'expired') return { ok: false, reason: `KIRI job ${result.status}`, terminal: true };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // Timed out waiting â€” NOT a confirmed failure. The job may still be processing
  // on KIRI's side. Mark it distinctly so the webhook or a later check can still
  // pick it up instead of the owner being told it failed when it might not have.
  return { ok: false, reason: 'Timed out waiting for KIRI (still may finish later)', terminal: false };
}

// Gets the (time-limited) download URL for the finished model zip.
async function getDownloadUrl(serialize) {
  if (!isConfigured()) return { ok: false, reason: 'KIRI not configured' };
  try {
    const res = await axios.get(`${KIRI_BASE}/model/getModelZip`, {
      params: { serialize },
      headers: authHeader()
    });
    if (res.data && res.data.ok) {
      return { ok: true, url: res.data.data.modelUrl || res.data.data.url };
    }
    return { ok: false, reason: res.data?.msg || 'Could not get download link' };
  } catch (err) {
    return { ok: false, reason: err.response?.data?.msg || err.message };
  }
}

// Downloads the zip from KIRI, extracts it, finds the .glb inside, moves it
// into uploads/models, and returns the public URL path the website can use.
async function downloadAndSaveGlb(serialize, productId) {
  const dl = await getDownloadUrl(serialize);
  if (!dl.ok) return dl;

  const tmpDir = path.join('uploads', 'tmp_' + serialize);
  const zipPath = path.join(tmpDir, 'model.zip');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const response = await axios.get(dl.url, { responseType: 'stream', timeout: 120000 });
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(zipPath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    await extractZip(zipPath, { dir: path.resolve(tmpDir) });

    const findGlb = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findGlb(fullPath);
          if (found) return found;
        } else if (entry.name.toLowerCase().endsWith('.glb')) {
          return fullPath;
        }
      }
      return null;
    };

    const glbPath = findGlb(tmpDir);
    if (!glbPath) return { ok: false, reason: 'No .glb file found in KIRI export' };

    const finalName = `product-${productId}-${Date.now()}.glb`;
    const finalPath = path.join('uploads', 'models', finalName);
    fs.copyFileSync(glbPath, finalPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { ok: true, modelUrl: '/uploads/models/' + finalName };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, reason: err.message };
  }
}

module.exports = { isConfigured, uploadPhotoSet, getStatus, pollUntilDone, getDownloadUrl, downloadAndSaveGlb };

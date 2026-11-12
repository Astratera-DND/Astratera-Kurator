// Main-process side of the Kodex connection: reading a package from disk (.json, .zip or a folder),
// the watched inbox, the loopback API that Kodex can push to, and the client that pushes to Kodex.
// Plain Node (no Electron), so it is testable. The data logic itself lives in kodexSync.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const API = '/astratera/v1';
const MAX_JSON = 50 * 1024 * 1024;

// --- minimal zip reader (stored + deflate) ---------------------------------------
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression (${method}).`);
    if (data.length !== usize && method === 8) throw new Error('The zip file is damaged.');
    out.push({ name, data });
  }
  return out;
}

function safeJoin(base, rel) {
  const full = path.resolve(base, rel);
  const root = path.resolve(base) + path.sep;
  if (full !== path.resolve(base) && !full.startsWith(root)) return null;
  return full;
}

// Absolute image paths a package refers to (main only lets the renderer read these).
function imagePathsOf(pkg) { return (pkg.entities || []).map((pe) => pe.image && pe.image.path).filter(Boolean).map((p) => path.resolve(p)); }

// Reads a package from a .json file, a .zip or a folder. Image references are turned into absolute paths
// (zip contents are unpacked into a temporary folder) and listed in `allowedImages`.
function readPackage(source) {
  const st = fs.statSync(source);
  let baseDir, jsonText, name = path.basename(source);
  if (st.isDirectory()) {
    baseDir = source;
    const file = ['export.json', 'package.json'].map((f) => path.join(source, f)).find((f) => fs.existsSync(f))
      || fs.readdirSync(source).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => path.join(source, f))[0];
    if (!file) throw new Error('No export.json in that folder.');
    jsonText = fs.readFileSync(file, 'utf8');
  } else if (/\.zip$/i.test(source)) {
    const entries = readZipEntries(fs.readFileSync(source));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kurator-kodex-'));
    baseDir = tmp;
    entries.forEach((e) => {
      const full = safeJoin(tmp, e.name);
      if (!full) return;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, e.data);
    });
    const json = entries.filter((e) => /\.json$/i.test(e.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length || (/export\.json$/i.test(b.name) ? 1 : 0) - (/export\.json$/i.test(a.name) ? 1 : 0))[0];
    if (!json) throw new Error('No export.json inside that zip.');
    jsonText = json.data.toString('utf8');
    baseDir = path.dirname(safeJoin(tmp, json.name) || tmp);
  } else {
    baseDir = path.dirname(source);
    jsonText = fs.readFileSync(source, 'utf8');
  }
  const pkg = JSON.parse(jsonText.replace(/^﻿/, ''));
  return { pkg: resolveImages(pkg, baseDir), name };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
function resolveImages(pkg, baseDir) {
  const allowed = new Set();
  const assetById = new Map();
  (pkg.assets || []).forEach((a) => { if (a && (a.id || a.file || a.path)) assetById.set(a.id || a.file || a.path, a); });
  function fix(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const cand = ref.path || ref.file || (ref.asset && (assetById.get(ref.asset) || {}).file) || null;
    if (!cand) return null;
    const full = path.isAbsolute(cand) ? cand : safeJoin(baseDir, cand);
    if (!full || !IMAGE_EXT.test(full) || !fs.existsSync(full)) return null;
    allowed.add(path.resolve(full));
    return Object.assign({}, ref, { path: full });
  }
  (pkg.entities || []).forEach((pe) => {
    const img = fix(pe.image) || fix(pe.cover) || fix((pe.images || [])[0]);
    pe.image = img;
  });
  return pkg;
}

// --- the inbox --------------------------------------------------------------------
function scanInbox(dir, now) {
  if (!dir || !fs.existsSync(dir)) return [];
  const t = now || Date.now();
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (d.name.startsWith('.') || /\.part$/i.test(d.name) || /\.ready$/i.test(d.name)) return;
    const full = path.join(dir, d.name);
    let kind = null;
    if (d.isFile() && /\.(json|zip)$/i.test(d.name)) kind = 'file';
    else if (d.isDirectory() && (fs.existsSync(path.join(full, 'export.json')) || fs.existsSync(path.join(full, 'package.json')))) kind = 'folder';
    if (!kind) return;
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { return; }
    const ready = fs.existsSync(`${full}.ready`) || fs.existsSync(path.join(full, '.ready'));
    if (!ready && t - mtime < 3000) return;          // probably still being written
    out.push({ name: d.name, path: full, kind, mtime, key: `${d.name}:${Math.round(mtime)}` });
  });
  return out.sort((a, b) => b.mtime - a.mtime);
}

// --- discovery file + loopback API --------------------------------------------------
function endpointsDir() {
  if (process.env.ASTRATERA_ENDPOINTS_DIR) return process.env.ASTRATERA_ENDPOINTS_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Astratera', 'endpoints');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'astratera', 'endpoints');
}
function endpointFile(app) { return path.join(endpointsDir(), `${app}.json`); }

function readEndpoint(app) {
  try { return JSON.parse(fs.readFileSync(endpointFile(app), 'utf8')); } catch { return null; }
}

function request({ port, method, pathName, token, body, timeout }) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method,
      headers: Object.assign({ Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, token ? { Authorization: `Bearer ${token}` } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeout || 8000, () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Is the other tool running? Returns { running, context, port, token } (token only for the caller).
async function probe(app) {
  const ep = readEndpoint(app);
  if (!ep || !ep.port) return { running: false };
  const r = await request({ port: ep.port, method: 'GET', pathName: `${API}/ping`, timeout: 1500 });
  if (r.status !== 200) return { running: false };
  return { running: true, context: (r.json && r.json.context) || ep.context || {}, version: r.json && r.json.version, port: ep.port, token: ep.token };
}

async function pushToKodex(pkg) {
  const p = await probe('kodex');
  if (!p.running) return { ok: false, notRunning: true, error: 'Kodex is not running (or its push API is off).' };
  const r = await request({ port: p.port, method: 'POST', pathName: `${API}/import`, token: p.token, body: pkg, timeout: 60000 });
  if (r.status >= 200 && r.status < 300) return { ok: true, result: r.json || {}, context: p.context };
  return { ok: false, error: (r.json && (r.json.error || r.json.message)) || r.error || `Kodex answered ${r.status}.` };
}

// Where is a push now? Kodex answers GET /import/<id> with { status: pending-review | applied | cancelled, ids }.
async function kodexImportStatus(importId) {
  const p = await probe('kodex');
  if (!p.running) return { ok: false, notRunning: true };
  const r = await request({ port: p.port, method: 'GET', pathName: `${API}/import/${encodeURIComponent(importId)}`, token: p.token, timeout: 4000 });
  if (r.status === 200 && r.json) return { ok: true, status: r.json.status, ids: r.json.ids || {}, report: r.json.report || null };
  return { ok: false, error: r.error || `Kodex answered ${r.status}.` };
}

// --- Open in Kodex: page picker + open -----------------------------------------------
const PLACE_TYPES = new Set(['city', 'district', 'venue', 'region', 'planet', 'system', 'location', 'place', 'country', 'continent', 'building', 'room', 'dungeon', 'village', 'town', 'station', 'ship', 'moon', 'galaxy', 'sector', 'world', 'realm', 'landmark']);
const NPC_TYPES = new Set(['npc', 'villain', 'player', 'monster']);
const fold = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function kodexPagesLive(p, q, type, limit) {
  const qs = `q=${encodeURIComponent(q || '')}&type=${encodeURIComponent(type || '')}&limit=${limit || 200}`;
  const r = await request({ port: p.port, method: 'GET', pathName: `${API}/pages?${qs}`, token: p.token, timeout: 6000 });
  if (r.status === 200 && r.json && Array.isArray(r.json.pages)) {
    return { ok: true, source: 'live', workspace: r.json.workspace || '', total: r.json.total || r.json.pages.length, truncated: !!r.json.truncated, pages: r.json.pages };
  }
  return { ok: false, error: (r.json && r.json.error) || r.error || `Kodex answered ${r.status}.` };
}

// Read <workspaceDir>/index.json (Kodex index version 12+). Returns { ok, pages (raw), workspace } or { ok:false, error }.
function readWorkspaceIndex(dir) {
  if (!dir) return { ok: false, error: 'Kodex is not running and no workspace folder is known yet. Start Kodex once, or set the folder in Settings.' };
  let version = 0;
  try { version = parseInt(fs.readFileSync(path.join(dir, 'index.version'), 'utf8'), 10) || 0; } catch { /* missing */ }
  let arr = null;
  try { arr = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { /* missing */ }
  if (!Array.isArray(arr) || version < 12) return { ok: false, error: 'The Kodex workspace index is missing or too old. Start Kodex once so it can update it.' };
  let workspace = '';
  try { workspace = String(JSON.parse(fs.readFileSync(path.join(dir, 'codex.json'), 'utf8')).name || ''); } catch { /* optional */ }
  return { ok: true, pages: arr, workspace };
}

function searchIndex(dir, q, type, limit) {
  const idx = readWorkspaceIndex(dir);
  if (!idx.ok) return idx;
  const byId = new Map(); idx.pages.forEach((e) => { if (e && e.id) byId.set(e.id, e); });
  const parentsOf = new Set(); idx.pages.forEach((e) => { if (e && e.placeParent) parentsOf.add(e.placeParent); });
  const chain = (startId) => { // outermost first
    const out = []; const seen = new Set(); let cur = startId;
    while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); out.unshift(byId.get(cur)); cur = byId.get(cur).placeParent; }
    return out;
  };
  const isPlace = (e) => PLACE_TYPES.has(e.type) || e.placeParent || parentsOf.has(e.id);
  const t = String(type || '').toLowerCase();
  const words = fold(q).split(/\s+/).filter(Boolean);
  const rows = [];
  idx.pages.forEach((e) => {
    if (!e || !e.id) return;
    const isNpc = NPC_TYPES.has(e.type);
    if (t === 'npc' && !isNpc) return;
    if (t === 'encounter' && e.type !== 'encounter') return;
    if (t === 'location' && !(e.type !== 'encounter' && !isNpc && isPlace(e))) return;
    if (t && !['npc', 'encounter', 'location'].includes(t) && e.type !== t) return;
    let pathPages;
    if (isNpc || !isPlace(e)) pathPages = chain((e.places || [])[0]);
    else pathPages = chain(e.placeParent);
    const path_ = pathPages.map((x) => ({ id: x.id, name: x.title || '' }));
    const pathText = path_.map((x) => x.name).join(' › ');
    const name = e.title || '';
    const hay = fold(`${name} ${pathText} ${e.type}`);
    if (!words.every((w) => hay.includes(w))) return;
    const fn = fold(name), fq = fold(q).trim();
    const rank = !fq ? 3 : fn === fq ? 0 : fn.startsWith(fq) ? 1 : fn.includes(fq) ? 2 : 3;
    rows.push({ rank, page: { id: e.id, name, type: e.type, kind: isNpc ? 'npc' : e.type === 'encounter' ? 'encounter' : isPlace(e) ? 'location' : 'note', icon: e.icon || null, kuratorId: e.kuratorId || null, path: path_, pathText } });
  });
  rows.sort((a, b) => a.rank - b.rank || a.page.name.localeCompare(b.page.name, undefined, { sensitivity: 'base' }));
  const lim = Math.max(1, Math.min(5000, limit || 200));
  return { ok: true, source: 'file', workspace: idx.workspace, total: rows.length, truncated: rows.length > lim, pages: rows.slice(0, lim).map((x) => x.page) };
}

// Picker data: live when Kodex runs (also remembers its workspace folder), else the workspace folder.
// `knownDir` = the folder remembered from an earlier run. Returns { ok, source, workspace, pages, workspaceDir?, error? }.
async function kodexPages({ q, type, limit, knownDir } = {}) {
  const p = await probe('kodex');
  if (p.running) {
    const dir = (p.context && p.context.workspaceDir) || '';
    const r = await kodexPagesLive(p, q, type, limit);
    if (r.ok) return Object.assign(r, { workspaceDir: dir });
    // live API failed: try the files before giving up
    const f = searchIndex(dir || knownDir, q, type, limit);
    return f.ok ? Object.assign(f, { workspaceDir: dir || knownDir }) : r;
  }
  const f = searchIndex(knownDir, q, type, limit);
  return f.ok ? Object.assign(f, { workspaceDir: knownDir }) : f;
}

// Open a page in the running Kodex. { ok, found, title, type } | { ok:false, notRunning } | { ok:true, found:false }
async function kodexOpen(ids, opts) {
  const p = await probe('kodex');
  if (!p.running) return { ok: false, notRunning: true };
  const body = Object.assign({}, ids && ids.kodexId ? { kodexId: ids.kodexId } : { kuratorId: ids && ids.kuratorId }, opts && opts.newTab === false ? { newTab: false } : {}, opts && opts.section ? { section: opts.section } : {});
  const r = await request({ port: p.port, method: 'POST', pathName: `${API}/open`, token: p.token, body, timeout: 8000 });
  if (r.status === 200 && r.json && r.json.found) return { ok: true, found: true, id: r.json.id, title: r.json.title, type: r.json.type };
  if (r.status === 404) return { ok: true, found: false };
  return { ok: false, error: (r.json && r.json.error) || r.error || `Kodex answered ${r.status}.` };
}

function startApiServer({ version, getContext, onImport, onOpen }) {
  const token = crypto.randomBytes(24).toString('hex');
  const imports = new Map();
  let port = 0;
  const loopbackHost = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(h || ''));
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' }); res.end(b); };
    if (!loopbackHost(req.headers.host)) return send(403, { error: 'forbidden host' });
    if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.origin)) return send(403, { error: 'forbidden origin' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const authed = req.headers.authorization === `Bearer ${token}`;
    if (req.method === 'GET' && url.pathname === `${API}/ping`) return send(200, { app: 'kurator', version, apiVersion: 1, context: getContext() });
    if (!authed) return send(401, { error: 'missing or wrong token' });
    const m = url.pathname.match(new RegExp(`^${API}/import/([\\w-]+)$`));
    if (req.method === 'GET' && m) { const s = imports.get(m[1]); return s ? send(200, s) : send(404, { error: 'unknown import' }); }
    if (req.method === 'POST' && url.pathname === `${API}/import`) {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_JSON) { send(413, { error: 'package too large' }); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        let pkg; try { pkg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'body is not valid JSON' }); }
        if (!pkg || pkg.format !== 'astratera-kodex-export') return send(400, { error: 'not an astratera-kodex-export package' });
        const importId = crypto.randomBytes(8).toString('hex');
        const state = { importId, status: 'pending-review', counts: { entities: (pkg.entities || []).length } };
        imports.set(importId, state);
        try { onImport({ importId, pkg: resolveImages(pkg, os.tmpdir()) }); } catch (err) { return send(500, { error: err.message }); }
        send(202, state);
      });
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === `${API}/open`) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
        const ok = onOpen ? onOpen(b) : false;
        send(ok ? 200 : 404, { ok: !!ok });
      });
      return undefined;
    }
    return send(404, { error: 'unknown call' });
  });
  const file = endpointFile('kurator');
  function writeFile() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ app: 'kurator', apiVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString(), context: getContext() }, null, 2), 'utf8');
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      try { writeFile(); } catch (err) { /* discovery file is best effort */ }
      resolve({
        port, token, file,
        setStatus(importId, patch) { const s = imports.get(importId); if (s) Object.assign(s, patch); },
        refresh() { try { writeFile(); } catch { /* ignore */ } },
        close() { try { server.close(); } catch { /* ignore */ } try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(file); } catch { /* ignore */ } }
      });
    });
  });
}

module.exports = { imagePathsOf, resolveImages, readZipEntries, readPackage, scanInbox, endpointsDir, endpointFile, readEndpoint, probe, pushToKodex, kodexImportStatus, kodexPages, kodexOpen, readWorkspaceIndex, searchIndex, startApiServer };

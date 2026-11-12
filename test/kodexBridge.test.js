const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const B = require('../src/kodexBridge');
const sample = require('./fixtures/kodex-sample-export.json');

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => console.log(`ok  - ${name}`), (e) => { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); }));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const locals = [], centrals = []; let offset = 0;
  files.forEach(({ name, data, deflate }) => {
    const raw = Buffer.from(data); const comp = deflate ? zlib.deflateRawSync(raw) : raw; const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(Buffer.concat([ch, nm])); offset += 30 + nm.length + comp.length;
  });
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('reads a zip (export.json + assets), resolves image paths, blocks path tricks', () => {
  const dir = tmp();
  const pkg = JSON.parse(JSON.stringify(sample));
  pkg.entities[2].image = { file: 'assets/grey.png', kind: 'cover' };
  pkg.entities[3].image = { file: '../evil.png', kind: 'cover' };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const zip = makeZip([{ name: 'export.json', data: JSON.stringify(pkg), deflate: true }, { name: 'assets/grey.png', data: png }]);
  fs.writeFileSync(path.join(dir, 'pack.zip'), zip);
  const r = B.readPackage(path.join(dir, 'pack.zip'));
  assert.strictEqual(r.pkg.format, 'astratera-kodex-export');
  const grey = r.pkg.entities[2];
  assert.ok(fs.existsSync(grey.image.path) && fs.readFileSync(grey.image.path).equals(png));
  assert.strictEqual(r.pkg.entities[3].image, null);
  assert.deepStrictEqual(B.imagePathsOf(r.pkg), [path.resolve(grey.image.path)]);
});

test('reads a bare json and a folder', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(sample));
  assert.strictEqual(B.readPackage(path.join(dir, 'a.json')).pkg.entities.length, 4);
  const sub = path.join(dir, 'folder'); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'export.json'), JSON.stringify(sample));
  assert.strictEqual(B.readPackage(sub).pkg.entities.length, 4);
  assert.throws(() => B.readPackage(dir.replace(/[^/]+$/, '') + 'nonexistent-xyz'));
});

test('inbox: ignores .part and half-written files, honours .ready', () => {
  const dir = tmp(); const now = Date.now();
  fs.writeFileSync(path.join(dir, 'new.json'), '{}');
  fs.writeFileSync(path.join(dir, 'big.zip.part'), 'x');
  fs.writeFileSync(path.join(dir, 'old.json'), '{}'); fs.utimesSync(path.join(dir, 'old.json'), (now - 60000) / 1000, (now - 60000) / 1000);
  fs.writeFileSync(path.join(dir, 'fresh.zip'), 'x'); fs.writeFileSync(path.join(dir, 'fresh.zip.ready'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const names = B.scanInbox(dir, now).map((x) => x.name).sort();
  assert.deepStrictEqual(names, ['fresh.zip', 'old.json']);
});

test('push API: ping is open, import needs the token, loopback only, and Kurator can push to a fake Kodex', async () => {
  const dir = tmp(); process.env.ASTRATERA_ENDPOINTS_DIR = dir;
  const got = [];
  const srv = await B.startApiServer({ version: 't', getContext: () => ({ campaignName: 'Silverfen' }), onImport: (x) => got.push(x), onOpen: (b) => b.kuratorId === 'npc_1' });
  const ep = B.readEndpoint('kurator');
  assert.strictEqual(ep.port, srv.port); assert.strictEqual(ep.pid, process.pid);
  const probe = await B.probe('kurator');
  assert.ok(probe.running && probe.context.campaignName === 'Silverfen');
  const http = require('http');
  const call = (opts, body) => new Promise((resolve) => { const r = http.request(Object.assign({ host: '127.0.0.1', port: srv.port }, opts), (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: t })); }); if (body) r.write(body); r.end(); });
  assert.strictEqual((await call({ path: '/astratera/v1/import', method: 'POST' }, JSON.stringify(sample))).status, 401);
  assert.strictEqual((await call({ path: '/astratera/v1/ping', headers: { Host: 'evil.example.com' } })).status, 403);
  assert.strictEqual((await call({ path: '/astratera/v1/ping', headers: { Origin: 'https://evil.example.com' } })).status, 403);
  const auth = { Authorization: `Bearer ${srv.token}` };
  assert.strictEqual((await call({ path: '/astratera/v1/import', method: 'POST', headers: auth }, '{"format":"nope"}')).status, 400);
  const ok = await call({ path: '/astratera/v1/import', method: 'POST', headers: auth }, JSON.stringify(sample));
  assert.strictEqual(ok.status, 202); const id = JSON.parse(ok.body).importId;
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].pkg.entities.length, 4);
  srv.setStatus(id, { status: 'applied' });
  assert.strictEqual(JSON.parse((await call({ path: `/astratera/v1/import/${id}`, headers: auth })).body).status, 'applied');
  assert.strictEqual((await call({ path: '/astratera/v1/open', method: 'POST', headers: auth }, '{"kuratorId":"npc_1"}')).status, 200);
  // fake Kodex that accepts a push
  const received = [];
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/import\/abc$/.test(req.url)) { res.end(JSON.stringify({ status: 'applied', ids: { npc_1: 'K9' } })); return; }
    if (req.url.endsWith('/ping')) { res.end(JSON.stringify({ app: 'kodex', context: { workspace: 'W' } })); return; }
    let t = ''; req.on('data', (c) => (t += c)); req.on('end', () => { received.push({ auth: req.headers.authorization, body: JSON.parse(t) }); res.writeHead(202); res.end(JSON.stringify({ importId: 'x', ids: { npc_1: 'K1' } })); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'kodex.json'), JSON.stringify({ app: 'kodex', port: fake.address().port, token: 'tok' }));
  const push = await B.pushToKodex({ format: 'astratera-kurator-export', entities: [] });
  assert.ok(push.ok && push.result.ids.npc_1 === 'K1'); assert.strictEqual(received[0].auth, 'Bearer tok');
  const stt = await B.kodexImportStatus('abc'); assert.ok(stt.ok && stt.status === 'applied' && stt.ids.npc_1 === 'K9');
  fake.close();
  fs.unlinkSync(path.join(dir, 'kodex.json'));
  assert.ok((await B.pushToKodex({})).notRunning);
  srv.close();
  assert.ok(!fs.existsSync(srv.file));
});

// --- Open in Kodex (run after the tests above: they share the endpoints env variable) ---
const openTests = [];
function seqTest(name, fn) { openTests.push([name, fn]); }
const PAGES = [
  { id: 'p_city', title: 'Rust Gate', type: 'city', placeParent: null, places: [] },
  { id: 'p_ring', title: 'Lower Ring', type: 'district', placeParent: 'p_city', places: [] },
  { id: 'p_doc', title: 'Doctor', type: 'npc', placeParent: null, places: ['p_ring'], kuratorId: 'npc_77' },
  { id: 'p_doc2', title: 'Doctor Vance', type: 'villain', places: ['p_city'] },
  { id: 'p_enc', title: 'Doctor on the road', type: 'encounter', places: [] },
  { id: 'p_loop_a', title: 'Loop A', type: 'region', placeParent: 'p_loop_b', places: [] },
  { id: 'p_loop_b', title: 'Loop B', type: 'region', placeParent: 'p_loop_a', places: [] },
  { id: 'p_note', title: 'Éclair recipe', type: 'note', places: [] }
];
function wsDir(version) {
  const d = tmp(); fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(PAGES));
  if (version != null) fs.writeFileSync(path.join(d, 'index.version'), String(version));
  fs.writeFileSync(path.join(d, 'codex.json'), JSON.stringify({ name: 'Astratera' }));
  return d;
}
seqTest('index fallback: order, path text, type filters, accent-insensitive search', () => {
  const d = wsDir(12);
  const all = B.searchIndex(d, 'doctor', '', 50);
  assert.ok(all.ok && all.source === 'file' && all.workspace === 'Astratera');
  assert.deepStrictEqual(all.pages.map((x) => x.id), ['p_doc', 'p_enc', 'p_doc2']);      // exact, then starts-with in A-Z order
  assert.strictEqual(all.pages[0].pathText, 'Rust Gate › Lower Ring');
  assert.strictEqual(all.pages[0].kuratorId, 'npc_77');
  assert.deepStrictEqual(B.searchIndex(d, '', 'npc', 50).pages.map((x) => x.id), ['p_doc', 'p_doc2']);
  assert.deepStrictEqual(B.searchIndex(d, '', 'encounter', 50).pages.map((x) => x.id), ['p_enc']);
  const locs = B.searchIndex(d, '', 'location', 50).pages.map((x) => x.id);
  assert.ok(locs.includes('p_city') && locs.includes('p_ring') && !locs.includes('p_doc') && !locs.includes('p_enc'));
  assert.deepStrictEqual(B.searchIndex(d, 'lower ring', '', 50).pages.map((x) => x.id).sort(), ['p_doc', 'p_ring'].sort()); // words may hit the path
  assert.deepStrictEqual(B.searchIndex(d, 'eclair', '', 50).pages.map((x) => x.id), ['p_note']);
  assert.ok(B.searchIndex(d, '', 'location', 50).pages.find((x) => x.id === 'p_loop_a').path.length <= 2); // loops stop
  assert.strictEqual(B.searchIndex(d, '', '', 3).truncated, true);
});
seqTest('index fallback: too old or missing -> clear error', () => {
  assert.ok(!B.searchIndex(wsDir(11), 'x', '', 5).ok);
  assert.ok(!B.searchIndex(wsDir(null), 'x', '', 5).ok);
  assert.ok(!B.searchIndex('', 'x', '', 5).ok);
});
seqTest('kodexPages / kodexOpen: live API, 404, closed -> files', async () => {
  const dir = tmp(); process.env.ASTRATERA_ENDPOINTS_DIR = dir;
  const seen = [];
  const fake = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization || ''}`);
    let t = ''; req.on('data', (c) => (t += c)); req.on('end', () => {
      if (req.url.startsWith('/astratera/v1/ping')) { res.writeHead(200); return res.end(JSON.stringify({ ok: true, context: { workspace: 'Astratera', workspaceDir: 'D:\\ws' } })); }
      if (req.url.startsWith('/astratera/v1/pages')) { res.writeHead(200); return res.end(JSON.stringify({ workspace: 'Astratera', total: 1, truncated: false, pages: [{ id: 'k1', name: 'Doctor', type: 'npc', path: [], pathText: '' }] })); }
      if (req.url.startsWith('/astratera/v1/open')) {
        const b = JSON.parse(t);
        if (b.kodexId === 'k1') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, found: true, id: 'k1', title: 'Doctor', type: 'npc' })); }
        res.writeHead(404); return res.end(JSON.stringify({ ok: false, found: false, error: 'no such page' }));
      }
      res.writeHead(500); res.end('{}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'kodex.json'), JSON.stringify({ app: 'kodex', port: fake.address().port, token: 'tok' }));
  const live = await B.kodexPages({ q: 'doc', type: 'npc', knownDir: '' });
  assert.ok(live.ok && live.source === 'live' && live.pages[0].id === 'k1' && live.workspaceDir === 'D:\\ws');
  assert.ok(seen.some((x) => x.startsWith('GET /astratera/v1/pages?q=doc&type=npc') && x.endsWith('Bearer tok')));
  const o1 = await B.kodexOpen({ kodexId: 'k1' }); assert.ok(o1.ok && o1.found && o1.title === 'Doctor');
  const o2 = await B.kodexOpen({ kodexId: 'zzz' }); assert.ok(o2.ok && o2.found === false);
  fake.close(); fs.unlinkSync(path.join(dir, 'kodex.json'));
  assert.ok((await B.kodexOpen({ kodexId: 'k1' })).notRunning);
  const closed = await B.kodexPages({ q: 'doc', knownDir: wsDir(12) });
  assert.ok(closed.ok && closed.source === 'file' && closed.pages.length === 3);
  const none = await B.kodexPages({ q: 'doc', knownDir: '' }); assert.ok(!none.ok && /not running/i.test(none.error));
});
seqTest('settings default for the remembered workspace folder', () => {
  const S = require('../src/settings');
  assert.strictEqual(S.loadSettings(tmp()).kodexWorkspaceDir, '');
});
Promise.all(pending.slice()).then(async () => {
  for (const [name, fn] of openTests) {
    try { await fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); }
  }
  if (failures) { console.log(`${failures} failed`); process.exit(1); }
});

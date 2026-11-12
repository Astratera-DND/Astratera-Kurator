// Kodex <-> Kurator sync core. Pure data logic (no files, no Electron), so it
// is testable and shared by main + renderer.
//
//   planImport(campaign, pkg, options)  -> plan   (reads only; nothing is changed)
//   applyImport(campaign, pkg, plan, options) -> report   (the only function that writes)
//   buildKuratorExport(campaign, options) -> { pkg, commit }   (Kurator -> Kodex)
//
// The unit of the whole sync is the "target": summary, profile.<k>, statblock,
// note:<role>, topic:<role>, beat:<role>, description, presence, event:<id>.
// For every target Kurator remembers (entity.external.kodex.map[key]):
//   base  = the Kodex markdown at the last transfer       (common ancestor)
//   hash  = sha1(base)
//   kbase = the Kurator text that was written then        (so "edited in Kurator" is detectable)
//   moduleId = the content module that holds it (notes, topics, beats, descriptions, events)
// Nothing is ever deleted, and nothing that differs on both sides is overwritten
// without the user's choice. Applying the same package twice changes nothing.
(function () {

const _dm = (typeof module !== 'undefined' && module.exports) ? require('./dataModel') : window.DataModel;
const _enc = (typeof module !== 'undefined' && module.exports) ? require('./encounters') : window.Encounters;
const _cond = (typeof module !== 'undefined' && module.exports) ? require('./conditions') : window.Conditions;
const _constants = (typeof module !== 'undefined' && module.exports) ? require('./constants') : window.Constants;
const _cc = (typeof module !== 'undefined' && module.exports) ? require('./characterCard') : window.CharacterCard;

const IMPORT_FORMAT = 'astratera-kodex-export';
const EXPORT_FORMAT = 'astratera-kurator-export';
const NEW_CP = '__new__';

// --- sha1 (sync, UTF-8; Kodex hashes are sha1 of the markdown) ---------------
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function sha1(str) {
  const bytes = utf8Bytes(String(str == null ? '' : str));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  const rol = (n, s) => ((n << s) | (n >>> (32 - s))) >>> 0;
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = ((bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) | (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]) >>> 0;
    for (let t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rol(a, 5) + (f >>> 0) + e + k + w[t]) >>> 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const trim = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();

// --- Markdown -> Kurator markup ------------------------------------------------
// opts.mention(kodexId, name) -> markup for a link to another Kodex page.
// opts.stats: object that collects { dropped: n } counts for the report.
function mdToMarkup(md, opts) {
  const o = opts || {};
  const stats = o.stats || {};
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
  const mention = o.mention || ((id, name) => `**${name}**`);
  function inline(s) {
    let t = String(s).replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, () => { bump('images'); return ''; });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, href) => {
      if (/^kodex:/i.test(href)) return mention(href.replace(/^kodex:/i, ''), text);
      if (/^kodex-check:/i.test(href)) return o.check ? o.check(href.replace(/^kodex-check:/i, ''), text) : text;
      if (/^https?:/i.test(href)) return text === href ? href : `${text} (${href})`;
      return text;
    });
    t = t.replace(/(^|[^\w_])__([^_\n]+)__(?![\w_])/g, '$1**$2**');
    t = t.replace(/`([^`\n]+)`/g, '$1');
    return t;
  }
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = false;
  let stack = [];
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { out.push(raw); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { out.push(''); stack = []; continue; }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw) && raw.includes('|')) continue;
    let m;
    if ((m = raw.match(/^\s*\|(.+)\|\s*$/))) {
      out.push('- ' + inline(m[1].split('|').map((c) => c.trim()).filter((c) => c !== '').join(' · '))); stack = []; continue;
    }
    if ((m = raw.match(/^\s*#{1,6}\s+(.*)$/))) { out.push('**' + inline(m[1]).replace(/\*\*/g, '') + '**'); stack = []; continue; }
    if ((m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      const indent = m[1].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1] > indent) stack.pop();
      if (!stack.length || stack[stack.length - 1] < indent) stack.push(indent);
      const level = stack.length - 1;
      const body = inline(m[3].replace(/^\[[ xX]\]\s+/, ''));
      out.push('\t'.repeat(level) + '- ' + body);
      continue;
    }
    stack = [];
    out.push(inline(raw.replace(/^\s*>\s?/, '')));
  }
  // a page that is not imported is written as **Name**; when Kodex already had it bold that gives ****Name****
  return out.join('\n').replace(/\*\*\*\*([^*\n]+?)\*\*\*\*/g, '**$1**').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
}

// --- Kurator markup -> Markdown ------------------------------------------------
// opts.nameOf(entityId) -> { name, kodexId|null } | null.   opts.mentions: { 'Name': kodexId } for pages that
// are not Kurator entities (restores their links).  Collects stripped Kurator-only tokens in opts.stats.
function markupToMd(text, opts) {
  const o = opts || {};
  const stats = o.stats || {};
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
  let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  t = t.replace(/\[\[SAY:[^\]]+\]\]([\s\S]*?)\[\[\/SAY\]\]/g, (m, inner) => (/^\s*["“]/.test(inner) ? inner : `"${inner}"`));
  t = t.replace(/\[\[DCCHECK:([a-zA-Z0-9_]+)\]\]/g, (m, id) => {
    const r = o.checkOf ? o.checkOf(id) : null;
    if (!r) { bump('kuratorOnly'); return ''; }
    return `[DC check: ${r.label}](kodex-check:${r.id})`;
  });
  t = t.replace(/\[\[REWARD:[^\]]*\]\]/g, () => { bump('kuratorOnly'); return ''; });
  t = t.replace(/\[\[\/?(?:IF|JUMP|DIRBTN|SCENEBTN|QFBTN|MUSICBTN|GREY)(?::[^\]]*)?\]\]/g, () => { bump('kuratorOnly'); return ''; });
  t = t.replace(/\[\[\/?[A-Z]{2,}[^\]]*\]\]/g, () => { bump('kuratorOnly'); return ''; });
  t = t.replace(/\[\[([a-z]+_[a-z0-9]+)\]\]/g, (m, id) => {
    const r = o.nameOf ? o.nameOf(id) : null;
    if (!r) return m.slice(2, -2) === id ? '' : '';
    return r.kodexId ? `[${r.name}](kodex:${r.kodexId})` : `**${r.name}**`;
  });
  t = t.split('\n').map((line) => {
    let l = line;
    const whole = l.match(/^\s*\^\^([\s\S]+?)\^\^\s*$/);
    if (whole) return `> DM: ${whole[1]}`;
    l = l.replace(/\^\^([\s\S]+?)\^\^/g, '(DM: $1)');
    const b = l.match(/^(\t*)- (.*)$/);
    if (b) l = '  '.repeat(b[1].length) + '- ' + b[2];
    l = l.replace(/(^|[^\w\]])_([^_\n[\]]+)_(?![\w])/g, '$1*$2*');
    return l;
  }).join('\n');
  if (o.mentions) {
    Object.keys(o.mentions).forEach((name) => {
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\*\\*${safe}\\*\\*`, 'g'), `[${name}](kodex:${o.mentions[name]})`);
    });
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// --- small helpers -----------------------------------------------------------
function plain(md) { return trim(mdToMarkup(md)).replace(/\*\*|~~|\^\^/g, ''); }
function ext(entity) { return entity && entity.external && entity.external.kodex ? entity.external.kodex : null; }
function ensureExt(entity, kodexId, workspace) {
  if (!entity.external || typeof entity.external !== 'object') entity.external = {};
  if (!entity.external.kodex) entity.external.kodex = { id: kodexId, workspace: workspace || '', importedAt: new Date().toISOString(), map: {} };
  const k = entity.external.kodex;
  if (kodexId) k.id = kodexId;
  if (workspace) k.workspace = workspace;
  if (!k.map || typeof k.map !== 'object') k.map = {};
  return k;
}
function typeOf(pe) { return pe.kind === 'location' || pe.kind === 'encounter' ? 'location' : pe.kind === 'npc' ? 'npc' : null; }
function isEncPkg(pe) { return pe.kind === 'encounter'; }
// An encounter keeps all its content on the one hidden encounter checkpoint, and its keys are not suffixed with a checkpoint.
function cpFor(pe, cpId) { return isEncPkg(pe) ? _enc.RESERVED_CP_ID : cpId; }
function realKeyOf(pt, pe, cpId) { return pt.scoped && !isEncPkg(pe) && cpId !== NEW_CP ? `${pt.base}@${cpId}` : pt.key; }
// Who is "present here": the NPC cards (targets.presence) plus, for places, their children, for encounters their place cards.
function extraPresence(pe, pkg) {
  if (isEncPkg(pe)) return (pkg.entities || []).filter((x) => x.kind === 'location' && x.encounterId === pe.id).map((x) => x.id);
  return pe.children || [];
}
function sortedCheckpoints(c) { return (c.checkpoints || []).slice().sort((a, b) => a.order - b.order); }
function findCheckpointByLabel(c, label) {
  const l = trim(label).toLowerCase();
  return (c.checkpoints || []).find((x) => trim(x.label).toLowerCase() === l) || null;
}
function moduleOf(c, id) { return id ? (c.contentModules || []).find((m) => m.id === id) || null : null; }
// A title for the other side: the module's name, else the first line of its text.
function moduleTitle(m) { const n = trim(m && m.name); if (n) return n; const l = trim(String((m && (m.text || '')) || '').split('\n').find((x) => trim(x)) || '').replace(/^[-*>\s]+/, '').slice(0, 60); return l || 'Untitled'; }
function moduleText(m) { return m ? (m.type === 'description' ? (m.html || '') : (m.text || '')) : null; }
function sectionTitle(pe, role) {
  const s = (pe.sections || []).find((x) => x.role === role);
  return s && s.title ? s.title : role.charAt(0).toUpperCase() + role.slice(1);
}
function assignedTo(c, moduleId, entityId) { return (c.assignments || []).some((a) => a.moduleId === moduleId && a.entityId === entityId); }
function defaultModuleName(text, fallback) {
  const first = trim(text).split('\n')[0].replace(/\*\*|~~|\^\^|_/g, '').trim();
  return (first || fallback || 'Imported').slice(0, 80);
}

function statblockText(sb) {
  const s = sb || {};
  const ab = s.abilities || {};
  const lines = [];
  lines.push([s.size, s.creatureType, s.alignment].filter(Boolean).join(' · '));
  lines.push(`AC ${s.ac} · HP ${s.hp}${s.hpDice ? ` (${s.hpDice})` : ''} · Speed ${s.speed || '—'} · CR ${s.cr}`);
  lines.push(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((k) => `${k.toUpperCase()} ${ab[k]}`).join('  '));
  if (s.senses) lines.push(`Senses: ${s.senses}`);
  if (s.languages) lines.push(`Languages: ${s.languages}`);
  if (s.traits) lines.push(s.traits);
  if (s.actions) lines.push(s.actions);
  return lines.filter((x) => trim(x)).join('\n');
}

// --- reading the Kurator side -------------------------------------------------
function presenceBlock(c, locationId, cpId) {
  return (c.blocks || []).find((b) => b.kind === 'arrival' && b.locationId === locationId && b.timeId === cpId) || null;
}
function descriptionAt(c, locationId, cpId) {
  const a = (c.assignments || []).find((x) => x.entityId === locationId && x.timeId === cpId && (moduleOf(c, x.moduleId) || {}).type === 'description');
  return a ? moduleOf(c, a.moduleId) : null;
}
function canonicalStatblock(entity) {
  if (!entity || entity.type !== 'npc') return '';
  if (_cc.isDefaultStatblock(entity)) return '';
  return canonical(_cc.sanitizeStatblock(_cc.getStatblock(entity)));
}

// What Kurator currently holds for one target. { text } for text targets, { ids } for presence, { json } for statblock.
function kuratorNow(c, entity, base, rec, cpId) {
  if (!entity) return { text: null };
  if (base === 'summary') return { text: entity.summary || '' };
  if (base.startsWith('profile.')) return { text: (entity.profile || {})[base.slice(8)] || '' };
  if (base === 'statblock') return { text: canonicalStatblock(entity) };
  if (base === 'presence') { const b = presenceBlock(c, entity.id, cpId); return { ids: b ? (b.presence || []).slice() : [] }; }
  let m = rec && rec.moduleId ? moduleOf(c, rec.moduleId) : null;
  if (!m && base === 'description') m = descriptionAt(c, entity.id, cpId);
  return { text: m ? moduleText(m) : null, module: m, missing: !!(rec && rec.moduleId && !m) };
}

// --- package -> list of targets for one entity ----------------------------------
function packageTargets(pe) {
  const out = [];
  const tg = pe.targets || {};
  Object.keys(tg).forEach((key) => {
    const t = tg[key];
    if (!t) return;
    const type = typeOf(pe);
    if (key === 'statblock') {
      if (type !== 'npc' || !t.value) return;
      out.push({ key, base: key, kind: 'statblock', value: t.value, readonly: !!t.readonly, label: 'Stat block' });
      return;
    }
    if (key === 'presence') {
      if (type !== 'location') return;
      out.push({ key, base: key, kind: 'presence', value: Array.isArray(t.value) ? t.value : [], scoped: true, label: 'Present here' });
      return;
    }
    if (key.startsWith('profile.')) {
      const f = key.slice(8);
      if (!_cc.profileFieldsFor(type).some((x) => x.key === f)) return;
      const fld = _cc.PROFILE_FIELDS.find((x) => x.key === f);
      out.push({ key, base: key, kind: 'text', md: t.markdown || '', readonly: !!t.readonly, label: fld.label });
      return;
    }
    if (key === 'summary') { out.push({ key, base: key, kind: 'text', md: t.markdown || '', label: 'Summary' }); return; }
    const m = key.match(/^(note|topic|beat):(.+)$/);
    if (m) {
      const [, kind, role] = m;
      const dlg = kind === 'topic' && t.dialog && t.assignee && (t.assignee.name || t.assignee.id || t.assignee.kuratorId);
      if (kind === 'topic' && type !== 'npc' && !dlg) return;
      if (kind === 'beat' && type !== 'location') return;
      const title = t.title || sectionTitle(pe, role);
      const label = { note: 'Note', topic: 'Dialogue topic', beat: 'Section' }[kind] + ' · ' + title;
      out.push({ key, base: key, kind: 'text', md: t.markdown || '', readonly: !!t.readonly, label, module: kind, title, scoped: kind === 'beat', assignee: dlg ? t.assignee : null });
      return;
    }
    if (key === 'description') {
      if (type !== 'location') return;
      out.push({ key, base: key, kind: 'text', md: t.markdown || '', module: 'description', label: 'Description', scoped: true, title: 'Description' });
    }
  });
  // alternate stat blocks as one plain-text note
  if (typeOf(pe) === 'npc' && Array.isArray(pe.extraStatblocks) && pe.extraStatblocks.length) {
    const md = pe.extraStatblocks.map((x, i) => {
      const sb = x && x.statblock ? x.statblock : x;
      const name = (x && (x.name || x.title)) || `Form ${i + 2}`;
      return `**${name}**\n${statblockText(_cc.sanitizeStatblock(sb))}`;
    }).join('\n\n');
    out.push({ key: 'note:extraStatblocks', base: 'note:extraStatblocks', kind: 'text', md, module: 'note', label: 'Note · Alternate stat blocks', title: 'Alternate stat blocks', local: true });
  }
  return out;
}

// --- status -------------------------------------------------------------------
function classifyText(rec, kodexMd, kodexK, now, singular) {
  const nowT = now.text;
  if (!rec) {
    if (nowT == null || trim(nowT) === '') return 'new';
    if (!singular) return 'new';
    return trim(nowT) === trim(kodexK) ? 'same' : 'conflict';
  }
  if (now.missing) return 'missing';
  const kodexChanged = trim(kodexMd) !== trim(rec.base);
  const kuratorChanged = trim(nowT) !== trim(rec.kbase);
  if (!kodexChanged && !kuratorChanged) return 'unchanged';
  if (kodexChanged && !kuratorChanged) return 'kodex';
  if (!kodexChanged && kuratorChanged) return 'kurator';
  return trim(nowT) === trim(kodexK) ? 'same' : 'conflict';
}
const DEFAULT_CHOICE = { new: 'kodex', kodex: 'kodex', same: 'kodex', unchanged: 'skip', kurator: 'skip', conflict: null, missing: 'skip' };

function mentionResolverFor(c, pkg, extraIds, checkMap) {
  const byKodex = {};
  Object.values(c.entities).forEach((e) => { const k = ext(e); if (k && k.id) byKodex[k.id] = e.id; });
  Object.assign(byKodex, extraIds || {});
  const names = {};
  (pkg.entities || []).forEach((pe) => { names[pe.id] = pe.name; (pe.mentions || []).forEach((m) => { if (!names[m.id]) names[m.id] = m.name; }); });
  return {
    byKodex,
    mention: (id, name) => (byKodex[id] ? `[[${byKodex[id]}]]` : `**${name || names[id] || 'Unknown'}**`),
    check: (id, label) => ((checkMap || {})[id] ? `[[DCCHECK:${checkMap[id]}]]` : `**${label || 'DC check'}**`)
  };
}

// --- encounter collections -------------------------------------------------------
function normRoute(r) {
  if (!r) return null;
  const st = (x) => (x && trim(x.name) ? { name: trim(x.name), id: x.placeId || x.kodexId || null } : null);
  const out = { from: st(r.from), via: (r.via || []).map(st).filter(Boolean), to: st(r.to), note: trim(r.note) };
  return !out.from && !out.via.length && !out.to && !out.note ? null : out;
}
function colSigKodex(pc) { return canonical({ name: trim(pc.name), route: normRoute(pc.route), ids: (pc.entries || []).map((e) => e.encounterId || null) }); }
function colSigKurator(col) { return canonical({ name: trim(col.name), route: normRoute(col.route), ids: (col.entries || []).map((e) => e.kodexId || (e.encounterId ? `k:${e.encounterId}` : null)) }); }
function colExt(col) { return col && col.external && col.external.kodex ? col.external.kodex : null; }
function findCollection(c, pc) {
  const cols = _enc.list(c);
  let col = cols.find((x) => colExt(x) && colExt(x).id === pc.id);
  if (col) return { mode: 'external', kuratorId: col.id };
  const n = trim(pc.name).toLowerCase();
  col = cols.find((x) => !colExt(x) && trim(x.name).toLowerCase() === n);
  return col ? { mode: 'name', kuratorId: col.id } : { mode: 'new', kuratorId: null };
}
function collectionText(pc, route) {
  const lines = [];
  const rt = _enc.routeText(route || null);
  if (rt) lines.push(`Route: ${rt}`);
  (pc.entries || []).forEach((e) => lines.push(`${e.from === e.to ? e.from : `${e.from}–${e.to}`}  ${e.missing ? '(deleted in Kodex)' : (e.name || e.encounterId)}`));
  return lines.join('\n');
}
function convRoute(r) {
  const n = normRoute(r);
  if (!n) return null;
  const st = (x) => (x ? Object.assign({ name: x.name }, x.id ? { kodexId: x.id } : {}) : null);
  return { from: st(n.from), via: n.via.map(st), to: st(n.to), note: n.note };
}
function planCollections(campaign, pkg, opt) {
  const out = [];
  (pkg.encounterCollections || []).forEach((pc) => {
    if (!pc || !pc.id) return;
    const forced = opt.collectionLinks && opt.collectionLinks[pc.id];
    const matched = findCollection(campaign, pc);
    const match = forced === 'new' ? { mode: 'new', kuratorId: null } : matched;
    const col = match.kuratorId ? _enc.collectionById(campaign, match.kuratorId) : null;
    const sig = colSigKodex(pc);
    const rec = colExt(col);
    const empty = col && !col.entries.length && !col.route;
    const now = { text: !col ? null : (empty ? '' : colSigKurator(col)) };
    const status = classifyText(rec ? { base: rec.base, kbase: rec.kbase } : null, sig, sig, now, true);
    out.push({
      kodexId: pc.id, name: pc.name, kind: 'collection', dice: pc.dice || null, count: (pc.entries || []).length,
      link: forced === 'skip' ? { mode: 'skip', kuratorId: matched.kuratorId } : match, kuratorName: col ? col.name : null,
      status, choice: forced === 'skip' ? 'skip' : DEFAULT_CHOICE[status],
      kodexText: collectionText(pc, pc.route), kuratorText: col ? collectionText({ entries: _enc.tableOf(campaign, col).rows.map((r) => ({ from: r.from, to: r.to, name: r.name })) }, col.route) : ''
    });
  });
  return out;
}
function applyCollections(c, pkg, plan, idMap, report) {
  report.collectionsCreated = []; report.collectionsUpdated = [];
  (plan.collections || []).forEach((row) => {
    const pc = (pkg.encounterCollections || []).find((x) => x.id === row.kodexId);
    if (!pc || row.link.mode === 'skip') return;
    if (row.status === 'unchanged') { report.unchanged++; return; }
    if (row.status === 'conflict' && !row.choice) { report.conflictsOpen.push(`Collection ${row.name}`); return; }
    const sig = colSigKodex(pc);
    let col = row.link.kuratorId ? _enc.collectionById(c, row.link.kuratorId) : null;
    if (row.choice === 'kodex') {
      const isNew = !col || row.link.mode === 'new';
      if (isNew) col = _enc.createCollection(c, { name: pc.name });
      col.name = pc.name;
      col.route = convRoute(pc.route);
      col.entries = (pc.entries || []).map((e) => Object.assign({ encounterId: idMap[e.encounterId] || null, kodexId: e.encounterId, name: e.name || '' }, e.missing ? { missing: true } : {}));
      col.external = { kodex: { id: pc.id, workspace: plan.workspace || '', base: sig, kbase: colSigKurator(col) } };
      (isNew ? report.collectionsCreated : report.collectionsUpdated).push(col.name);
      report.applied++;
    } else if (col) {  // keep the Kurator table, but remember what Kodex had
      col.external = { kodex: { id: pc.id, workspace: plan.workspace || '', base: sig, kbase: colExt(col) ? colExt(col).kbase : colSigKurator(col) } };
    }
  });
}

// --- DC checks -------------------------------------------------------------------
// A check is one unit (like an encounter collection): name, type, mode, tiers, table and conditions.
// check.external.kodex = { id, workspace, base, hash, kbase }
//   base  = canonical JSON of the Kodex document at the last transfer (its sha1 is Kodex's own `hash`)
//   kbase = canonical JSON of the Kurator document (raw Kurator text) written / sent then
// rollLog and conditionId never leave Kurator.
const TRIG_ORDER = { success: 0, failure: 1, nat1: 2, nat20: 3 };
const isNat = (t) => t === 'nat1' || t === 'nat20';
function cext(check) { return check && check.external && check.external.kodex ? check.external.kodex : null; }
function validCheckType(t) { return (_constants.CHECK_TYPES || []).some((x) => x.key === t); }
function effectiveCheckMode(check) {
  if (check.mode === 'scale' || check.mode === 'passfail') return check.mode;
  const rows = (check.table || []).length > 0, outs = (check.conditions || []).length > 0;
  return outs && !rows ? 'passfail' : 'scale';
}
// One document shape for both sides; `text(x)` decides what the text fields hold (markdown, Kurator markup, ...).
function checkDoc(src, text) {
  return {
    name: trim(src.name), checkType: src.checkType, mode: src.mode, stackTiers: src.stackTiers !== false, allowBoth: !!src.allowBoth,
    table: (src.table || []).map((r) => ({ dc: Number(r.dc), markdown: trim(text(r.markdown != null ? r.markdown : r.text)) })).sort((a, b) => a.dc - b.dc),
    conditions: (src.conditions || []).map((x) => ({ trigger: x.trigger, dc: isNat(x.trigger) ? 0 : Number(x.dc), occurrence: Number(x.occurrence) || 1, markdown: trim(text(x.markdown != null ? x.markdown : x.text)) }))
      .sort((a, b) => ((TRIG_ORDER[a.trigger] || 0) - (TRIG_ORDER[b.trigger] || 0)) || (a.occurrence - b.occurrence))
  };
}
function kuratorCheckDoc(check, text) { return checkDoc(Object.assign({}, check, { mode: effectiveCheckMode(check) }), text || ((x) => x)); }
function kodexCheckDoc(pc, text) { return checkDoc(pc, text || ((x) => x)); }
function checkText(doc) {
  const lines = [`${doc.checkType} · ${doc.mode}${doc.stackTiers ? '' : ' · tiers do not stack'}`];
  doc.table.forEach((r) => lines.push(`DC ${r.dc}: ${r.markdown}`));
  doc.conditions.forEach((x) => lines.push(`${isNat(x.trigger) ? x.trigger : `${x.trigger} @ DC ${x.dc}`}${x.occurrence > 1 ? ` (#${x.occurrence})` : ''}: ${x.markdown}`));
  return lines.join('\n');
}
function matchCheck(c, pc, forced) {
  const checks = c.dcChecks || [];
  let hit = checks.find((x) => cext(x) && cext(x).id === pc.id);
  let mode = 'external';
  if (!hit) {
    hit = checks.find((x) => !(cext(x) && cext(x).id && cext(x).id !== pc.id) && ((pc.kuratorId && x.id === pc.kuratorId) || x.id === pc.id));
    mode = 'kuratorId';
  }
  if (!hit) {
    const n = trim(pc.name).toLowerCase();
    hit = n ? checks.find((x) => !cext(x) && trim(x.name).toLowerCase() === n && x.checkType === pc.checkType) : null;
    mode = 'name';
  }
  if (forced === 'new') return { mode: 'new', kuratorId: null };
  if (forced === 'skip') return { mode: 'skip', kuratorId: hit ? hit.id : null };
  return hit ? { mode, kuratorId: hit.id } : { mode: 'new', kuratorId: null };
}
function checkMapOf(c, pkg, opt) {
  const map = {};
  (pkg.dcChecks || []).forEach((pc) => {
    if (!pc || !pc.id) return;
    const m = matchCheck(c, pc, opt.collectionLinks && opt.collectionLinks[pc.id]);
    if (m.kuratorId) map[pc.id] = m.kuratorId;
  });
  return map;
}
function planDCChecks(campaign, pkg, opt, res) {
  const out = [];
  (pkg.dcChecks || []).forEach((pc) => {
    if (!pc || !pc.id) return;
    const forced = opt.collectionLinks && opt.collectionLinks[pc.id];
    const m = matchCheck(campaign, pc, forced);
    const check = m.kuratorId ? (campaign.dcChecks || []).find((x) => x.id === m.kuratorId) : null;
    const mdDoc = kodexCheckDoc(pc);
    const kDoc = kodexCheckDoc(pc, (t) => mdToMarkup(t, { mention: res.mention, check: res.check }));
    const rec = cext(check);
    const nowDoc = check ? kuratorCheckDoc(check) : null;
    const empty = check && !(check.table || []).length && !(check.conditions || []).length && !trim(check.name);
    const now = { text: !check ? null : (empty ? '' : canonical(nowDoc)) };
    const kodexMd = canonical(mdDoc);
    const bad = !validCheckType(pc.checkType);
    const status = bad ? 'unchanged' : classifyText(rec ? { base: rec.base, kbase: rec.kbase } : null, kodexMd, canonical(kDoc), now, true);
    out.push({
      kodexId: pc.id, name: pc.name || pc.checkType || 'DC check', kind: 'dcCheck', checkType: pc.checkType, mode: pc.mode,
      link: m, kuratorName: check ? (check.name || check.checkType) : null, status, choice: forced === 'skip' ? 'skip' : DEFAULT_CHOICE[status],
      invalid: bad ? `Unknown check type "${pc.checkType}"` : null,
      kodexText: checkText(kDoc), kuratorText: nowDoc ? checkText(nowDoc) : ''
    });
  });
  return out;
}
// Pass 1: make sure every check that will be written exists (so texts can link to it). Returns { kodexId: kuratorId }.
function prepareDCChecks(c, pkg, plan) {
  const map = {};
  (plan.dcChecks || []).forEach((row) => {
    const pc = (pkg.dcChecks || []).find((x) => x.id === row.kodexId);
    if (!pc) return;
    if (row.link.kuratorId && (c.dcChecks || []).some((x) => x.id === row.link.kuratorId)) { map[pc.id] = row.link.kuratorId; return; }
    if (row.link.mode === 'skip' || row.invalid) return;
    if (row.status === 'conflict' && !row.choice) return;
    if (row.choice !== 'kodex') return;
    const made = _dm.createDCCheck(c, { name: pc.name || '', checkType: pc.checkType, mode: pc.mode || null });
    row.link = { mode: 'new', kuratorId: made.id, created: true };
    map[pc.id] = made.id;
  });
  return map;
}
// Pass 2: write the contents.
function writeDCChecks(c, pkg, plan, res, report) {
  report.checksCreated = []; report.checksUpdated = [];
  (plan.dcChecks || []).forEach((row) => {
    const pc = (pkg.dcChecks || []).find((x) => x.id === row.kodexId);
    if (!pc || row.link.mode === 'skip') return;
    if (row.invalid) { report.warnings.push(`DC check "${row.name}" skipped: ${row.invalid}.`); return; }
    if (row.status === 'unchanged') { report.unchanged++; return; }
    if (row.status === 'conflict' && !row.choice) { report.conflictsOpen.push(`DC check ${row.name}`); return; }
    const check = row.link.kuratorId ? (c.dcChecks || []).find((x) => x.id === row.link.kuratorId) : null;
    if (!check) return;
    const mdDoc = kodexCheckDoc(pc);
    const base = canonical(mdDoc);
    const rec = { id: pc.id, workspace: plan.workspace || '', base, hash: pc.hash || sha1(base), importedAt: new Date().toISOString() };
    if (row.choice === 'kodex') {
      const conv = (t) => mdToMarkup(t, { mention: res.mention, check: res.check, stats: report.dropped });
      const old = { table: check.table || [], conditions: check.conditions || [] };
      check.name = trim(pc.name); check.checkType = pc.checkType; check.mode = pc.mode === 'scale' || pc.mode === 'passfail' ? pc.mode : null;
      check.stackTiers = pc.stackTiers !== false; check.allowBoth = !!pc.allowBoth;
      check.table = mdDoc.table.map((r, i) => ({ id: (old.table[i] && old.table[i].id) || `dcr_${Math.random().toString(36).slice(2, 11)}`, dc: r.dc, text: conv(r.markdown) }));
      check.conditions = mdDoc.conditions.map((x, i) => ({ id: (old.conditions[i] && old.conditions[i].id) || `dcond_${Math.random().toString(36).slice(2, 11)}`, trigger: x.trigger, dc: x.dc, occurrence: x.occurrence, text: conv(x.markdown) }));
      _cond.syncDCChecks(c);
      const pass = check.conditions.find((x) => x.trigger === 'success' || x.trigger === 'failure');
      if (pass) _cond.setPassDC(c, check, pass.dc); else _cond.refreshLinkDC(c, check);
      rec.kbase = canonical(kuratorCheckDoc(check));
      (row.link.created ? report.checksCreated : report.checksUpdated).push(check.name || check.checkType);
      report.applied++;
    } else rec.kbase = (cext(check) && cext(check).kbase) || canonical(kuratorCheckDoc(check));
    check.external = Object.assign({}, check.external || {}, { kodex: rec });
  });
}

// --- planning -----------------------------------------------------------------
function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return 'Not a Kodex package.';
  if (pkg.format !== IMPORT_FORMAT) return `Not a Kodex package (format "${pkg.format || 'missing'}").`;
  if (!Array.isArray(pkg.entities)) return 'The package has no entities.';
  return null;
}

function matchEntity(c, pe) {
  const type = typeOf(pe);
  const enc = isEncPkg(pe);
  const ents = Object.values(c.entities);
  let e = ents.find((x) => ext(x) && ext(x).id === pe.id);
  if (e) return { mode: 'external', kuratorId: e.id };
  if (pe.kuratorId && c.entities[pe.kuratorId] && c.entities[pe.kuratorId].type === type && _enc.isEncounter(c.entities[pe.kuratorId]) === enc) return { mode: 'kuratorId', kuratorId: pe.kuratorId };
  const n = trim(pe.name).toLowerCase();
  e = ents.find((x) => x.type === type && _enc.isEncounter(x) === enc && trim(x.name).toLowerCase() === n && !(ext(x) && ext(x).id && ext(x).id !== pe.id));
  if (e) return { mode: 'name', kuratorId: e.id };
  return { mode: 'new', kuratorId: null };
}

function planImport(campaign, pkg, options) {
  const err = validatePackage(pkg);
  if (err) return { error: err };
  const opt = options || {};
  const cpId = opt.checkpointId || (sortedCheckpoints(campaign)[0] || {}).id || NEW_CP;
  const plan = {
    version: 1, workspace: (pkg.source && pkg.source.workspace) || '', checkpointId: cpId,
    checkpointLabel: opt.checkpointLabel || `Imported ${new Date().toISOString().slice(0, 10)}`,
    useMilestones: opt.useMilestones !== false, entities: [], events: [], warnings: (pkg.warnings || []).slice(), counts: {}
  };
  const res = mentionResolverFor(campaign, pkg, {}, checkMapOf(campaign, pkg, opt));
  const scopeIds = new Set((pkg.scope && pkg.scope.entityIds) || pkg.entities.map((e) => e.id));
  pkg.entities.forEach((pe) => {
    const type = typeOf(pe);
    if (!type) { plan.warnings.push(`Skipped "${pe.name}" (${pe.kind || 'unknown'}): not an NPC or location.`); return; }
    const matched = matchEntity(campaign, pe);
    const forced = opt.links && opt.links[pe.id];
    const match = forced === 'new' ? { mode: 'new', kuratorId: null } : matched;
    const entity = match.kuratorId ? campaign.entities[match.kuratorId] : null;
    const k = ext(entity);
    const pent = { kodexId: pe.id, name: pe.name, type, link: forced === 'skip' ? { mode: 'skip', kuratorId: matched.kuratorId } : Object.assign({}, match), targets: [], kuratorName: matched.kuratorId ? campaign.entities[matched.kuratorId].name : null };
    const seen = new Set();
    const ecp = cpFor(pe, cpId);
    const extraPres = extraPresence(pe, pkg);
    if (isEncPkg(pe)) pent.encounter = true;
    packageTargets(pe).forEach((pt) => {
      const realKey = realKeyOf(pt, pe, cpId);
      const rec = k && k.map ? k.map[realKey] : null;
      seen.add(realKey);
      const row = { key: pt.key, base: pt.base, kind: pt.kind, label: pt.label, readonly: !!pt.readonly, scoped: !!pt.scoped };
      if (pt.kind === 'presence') {
        const want = (pt.value || []).concat(extraPres).map((id) => res.byKodex[id] || null).filter(Boolean);
        const have = entity && ecp !== NEW_CP ? (kuratorNow(campaign, entity, 'presence', rec, ecp).ids || []) : [];
        const add = want.filter((id) => !have.includes(id));
        const pend = (pt.value || []).concat(extraPres).filter((id) => !res.byKodex[id] && (pkg.entities || []).some((x) => x.id === id));
        row.kodexText = (pt.value || []).concat(extraPres).map((id) => (pkg.entities.find((x) => x.id === id) || { name: id }).name).join(', ');
        row.kuratorText = have.map((id) => (campaign.entities[id] || { name: id }).name).join(', ');
        row.status = add.length || pend.length ? 'new' : 'unchanged';
        row.choice = row.status === 'new' ? 'kodex' : 'skip';
        if (!(pt.value || []).length && !extraPres.length) return;
      } else if (pt.kind === 'statblock') {
        const kodexJ = canonical(_cc.sanitizeStatblock(pt.value));
        const now = entity ? kuratorNow(campaign, entity, 'statblock', rec) : { text: '' };
        row.kodexText = statblockText(_cc.sanitizeStatblock(pt.value));
        row.kuratorText = entity && now.text ? statblockText(_cc.getStatblock(entity)) : '';
        row.status = classifyText(rec, kodexJ, kodexJ, now, true);
        row.choice = DEFAULT_CHOICE[row.status];
      } else {
        const kodexK = mdToMarkup(pt.md, { mention: res.mention, check: res.check });
        const now = entity ? kuratorNow(campaign, entity, pt.base, rec, ecp) : { text: null };
        row.kodexText = kodexK;
        row.kuratorText = now.text || '';
        if (!trim(pt.md) && !rec) return;
        row.status = classifyText(rec, pt.md, kodexK, now, !pt.module || pt.module === 'description');
        row.choice = DEFAULT_CHOICE[row.status];
        if (pt.module && pt.module !== 'description') row.module = pt.module;
        if (pt.module === 'description') row.module = 'description';
        if (pt.assignee) {
          const who = resolveAssignee(campaign, res, pt.assignee);
          const inPkg = !who && (pkg.entities || []).some((x) => x.id === pt.assignee.id);
          row.assigneeName = who ? who.name : pt.assignee.name;
          row.label = `Dialogue · ${pt.title} → ${row.assigneeName || 'speaker'}${who || inPkg ? '' : ' (not in Kurator: stays here)'}`;
        }
      }
      pent.targets.push(row);
    });
    if (k && k.map && scopeIds.has(pe.id)) {
      Object.keys(k.map).forEach((key) => {
        if (!seen.has(key) && key !== 'summary' && !/^event:/.test(key) && !/^presence(@|$)/.test(key) && !/^note:(notes|extraStatblocks)/.test(key)) {
          if (!k.map[key].goneFlag) pent.targets.push({ key, base: key, kind: 'text', label: key, status: 'gone', choice: 'skip', kodexText: '', kuratorText: '' });
        }
      });
    }
    plan.entities.push(pent);
  });
  // milestone events
  const items = (pkg.checkpoints && pkg.checkpoints.items) || [];
  if (plan.useMilestones) {
    items.forEach((it) => {
      (it.pages || []).forEach((pid) => {
        const pent = plan.entities.find((x) => x.kodexId === pid);
        if (!pent) return;
        const cp = findCheckpointByLabel(campaign, it.title);
        const entity = pent.link.kuratorId ? campaign.entities[pent.link.kuratorId] : null;
        const rec = ext(entity) && ext(entity).map ? ext(entity).map[`event:${it.id}`] : null;
        const md = eventMarkdown(it);
        const kodexK = mdToMarkup(md, { mention: res.mention, check: res.check });
        const now = entity ? kuratorNow(campaign, entity, 'event', rec) : { text: null };
        const status = classifyText(rec, md, kodexK, now, false);
        pent.targets.push({ key: `event:${it.id}`, base: `event:${it.id}`, kind: 'text', module: 'event', label: `Milestone · ${it.title}`, status, choice: DEFAULT_CHOICE[status], kodexText: kodexK, kuratorText: now.text || '' });
        plan.events.push({ itemId: it.id, title: it.title, exists: !!cp });
      });
    });
  }
  plan.collections = planCollections(campaign, pkg, opt);
  plan.dcChecks = planDCChecks(campaign, pkg, opt, res);
  const states = {};
  plan.entities.forEach((e) => e.targets.forEach((t) => { states[t.status] = (states[t.status] || 0) + 1; }));
  plan.collections.forEach((r) => { states[r.status] = (states[r.status] || 0) + 1; });
  plan.dcChecks.forEach((r) => { states[r.status] = (states[r.status] || 0) + 1; });
  plan.counts = Object.assign({ entities: plan.entities.length, newEntities: plan.entities.filter((e) => e.link.mode === 'new').length, collections: plan.collections.length, dcChecks: plan.dcChecks.length }, states);
  return plan;
}
function eventMarkdown(it) {
  const kinds = it.kinds || [];
  const prefix = kinds.includes('rumor') || kinds.includes('rumour') ? 'Rumour: ' : kinds.includes('player') ? 'Players: ' : '';
  const body = it.markdown || it.text || '';
  return `**${prefix}${it.title}**${body ? `\n${body}` : ''}`;
}

// --- applying -----------------------------------------------------------------
function ensureGroupTree(c, pkg, entitiesNeedingGroups, report) {
  const groups = pkg.groups || [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const made = new Map();
  function groupFor(kodexGroupId) {
    if (!kodexGroupId || !byId.has(kodexGroupId)) return null;
    if (made.has(kodexGroupId)) return made.get(kodexGroupId);
    const g = byId.get(kodexGroupId);
    const parent = g.parentId ? groupFor(g.parentId) : null;
    const existing = (c.entityGroups || []).find((x) => trim(x.name).toLowerCase() === trim(g.name).toLowerCase() && (x.parentId || null) === (parent || null));
    const id = existing ? existing.id : (report.groupsCreated++, _dm.createEntityGroup(c, { name: g.name, parentId: parent }).id);
    made.set(kodexGroupId, id);
    return id;
  }
  return groupFor;
}
function groupKeyOf(pe, pkg) {
  const groupIds = new Set((pkg.groups || []).map((g) => g.id));
  if (pe.kind === 'location') {
    if (pe.parentId && groupIds.has(pe.parentId)) return pe.parentId;
    if (groupIds.has(pe.id)) return pe.id;
    return null;
  }
  if (pe.location && groupIds.has(pe.location.id)) return pe.location.id;
  const host = (pkg.entities || []).find((x) => x.kind === 'location' && ((x.presentHere || []).includes(pe.id) || (x.presentHereDeep || []).includes(pe.id)) && groupIds.has(x.id));
  return host ? host.id : null;
}

// Who speaks a Kodex dialog section: Kurator id, then the Kodex id (linked or created in this import), then the exact name.
function resolveAssignee(c, res, a) {
  if (!a) return null;
  const npc = (id) => { const e = id && c.entities[id]; return e && e.type === 'npc' && !e.encounter ? e : null; };
  let e = npc(a.kuratorId) || npc(res && res.byKodex && res.byKodex[a.id]);
  if (!e && a.id) e = Object.values(c.entities).find((x) => x.type === 'npc' && ext(x) && ext(x).id === a.id) || null;
  if (!e && trim(a.name)) { const n = trim(a.name).toLowerCase(); e = Object.values(c.entities).find((x) => x.type === 'npc' && trim(x.name).toLowerCase() === n) || null; }
  return e;
}

function writeText(c, entity, row, kodexK, rec, cpId, titleOf) {
  const base = row.base;
  if (base === 'summary') { entity.summary = kodexK; return {}; }
  if (base.startsWith('profile.')) {
    const f = base.slice(8);
    const fld = _cc.PROFILE_FIELDS.find((x) => x.key === f);
    let v = kodexK;
    if (fld && fld.short) v = trim(plainOf(kodexK)).split('\n')[0].slice(0, 200);
    _cc.setProfileField(entity, f, v);
    return { written: v };
  }
  const type = row.module === 'event' ? 'note' : row.module;
  let m = rec && rec.moduleId ? moduleOf(c, rec.moduleId) : null;
  if (!m && base === 'description') m = descriptionAt(c, entity.id, cpId);
  if (m) {
    if (m.type === 'description') m.html = kodexK; else m.text = kodexK;
    return { moduleId: m.id };
  }
  const name = type === 'note' ? defaultModuleName(kodexK, entity.name) : (titleOf || row.label);
  m = _dm.createContentModule(c, type === 'description' ? { type, name: defaultModuleName(kodexK, 'Description'), html: kodexK } : { type, name, text: kodexK });
  const timeId = row.module === 'event' ? row.eventCp : (row.scoped ? cpId : null);
  _dm.createAssignment(c, { moduleId: m.id, entityId: row.assignTo || entity.id, timeId });
  return { moduleId: m.id };
}
function plainOf(s) { return String(s).replace(/\*\*|~~|\^\^/g, ''); }

function applyImport(campaign, pkg, plan, options) {
  const err = validatePackage(pkg);
  if (err) return { error: err };
  const c = campaign;
  const opt = options || {};
  const report = { created: [], updated: [], unchanged: 0, conflictsOpen: [], flagged: [], dropped: {}, warnings: (plan.warnings || []).slice(), groupsCreated: 0, checkpointsCreated: 0, pendingImages: [], applied: 0 };
  // checkpoint
  let cpId = plan.checkpointId;
  if (cpId === NEW_CP || !(c.checkpoints || []).some((x) => x.id === cpId)) {
    const existing = findCheckpointByLabel(c, plan.checkpointLabel);
    cpId = existing ? existing.id : (report.checkpointsCreated++, _dm.createCheckpoint(c, { label: plan.checkpointLabel }).id);
  }
  // milestones -> checkpoints (in Kodex rank order)
  const cpOfItem = {};
  if (plan.useMilestones) {
    ((pkg.checkpoints && pkg.checkpoints.items) || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0)).forEach((it) => {
      if (!plan.entities.some((pe) => pe.targets.some((t) => t.key === `event:${it.id}`))) return;
      let cp = findCheckpointByLabel(c, it.title);
      if (!cp) { cp = _dm.createCheckpoint(c, { label: it.title }); report.checkpointsCreated++; }
      cpOfItem[it.id] = cp.id;
    });
  }
  const groupFor = ensureGroupTree(c, pkg, null, report);
  // entities
  const idMap = {};
  Object.values(c.entities).forEach((e) => { const k = ext(e); if (k && k.id) idMap[k.id] = e.id; });
  const todo = [];
  plan.entities.forEach((pent) => {
    const pe = pkg.entities.find((x) => x.id === pent.kodexId);
    if (!pe || pent.link.mode === 'skip') return;
    let entity = pent.link.kuratorId ? c.entities[pent.link.kuratorId] : null;
    let isNew = false;
    if (!entity || pent.link.mode === 'new') {
      entity = _dm.createEntity(c, { type: pent.type, name: pe.name, summary: '' });
      isNew = true;
      if (isEncPkg(pe)) { entity.encounter = true; entity.icon = 'wagon'; }
      else {
        const gk = groupKeyOf(pe, pkg);
        const gid = gk ? groupFor(gk) : null;
        if (gid) entity.groupId = gid;
      }
      report.created.push(entity.name);
    }
    if (isEncPkg(pe)) { _enc.ensureCheckpoint(c); if (!presenceBlock(c, entity.id, _enc.RESERVED_CP_ID)) _dm.createArrivalBlock(c, { locationId: entity.id, timeId: _enc.RESERVED_CP_ID }); }
    const k = ensureExt(entity, pe.id, plan.workspace);
    k.mentions = {};
    (pe.mentions || []).forEach((mm) => { if (!mm.inPackage) k.mentions[mm.name] = mm.id; });
    idMap[pe.id] = entity.id;
    todo.push({ pent, pe, entity, isNew });
  });
  const dcMap = prepareDCChecks(c, pkg, plan);
  const res = mentionResolverFor(c, pkg, idMap, dcMap);
  writeDCChecks(c, pkg, plan, res, report);
  const stats = report.dropped;
  todo.forEach(({ pent, pe, entity, isNew }) => {
    const k = ext(entity);
    let touched = isNew;
    pent.targets.forEach((row) => {
      if (row.status === 'gone') { report.flagged.push(`${entity.name}: "${row.key}" no longer exists in Kodex`); return; }
      if (row.status === 'conflict' && !row.choice) { report.conflictsOpen.push(`${entity.name} · ${row.label}`); return; }
      if (row.status === 'unchanged') { report.unchanged++; return; }
      if (row.status === 'missing') { report.flagged.push(`${entity.name} · ${row.label}: the Kurator copy was deleted, not recreated`); return; }
      if (!row.choice || row.choice === 'skip') return;
      const ecp = cpFor(pe, cpId);
      const realKey = realKeyOf(row, pe, cpId);
      const rec = k.map[realKey] || null;
      let pt = null;
      if (row.kind === 'presence') { applyPresence(c, pe, entity, ecp, res, k, realKey, report, pkg); touched = true; return; }
      const found = packageTargets(pe).find((x) => x.key === row.key);
      if (row.key.startsWith('event:')) {
        const it = ((pkg.checkpoints && pkg.checkpoints.items) || []).find((x) => `event:${x.id}` === row.key);
        if (!it) return;
        pt = { base: row.key, kind: 'text', md: eventMarkdown(it), module: 'event', scoped: false };
        row = Object.assign({}, row, { module: 'event', eventCp: cpOfItem[it.id] || cpId });
      } else pt = found;
      if (!pt) return;
      if (row.kind === 'statblock') {
        const json = canonical(_cc.sanitizeStatblock(pt.value));
        if (row.choice === 'kodex' || row.choice === 'both') {
          _cc.ensureCard(entity).statblock = _cc.sanitizeStatblock(pt.value);
          k.map[realKey] = { base: json, baseJson: json, hash: sha1(json), kbase: canonicalStatblock(entity) || json };
        } else k.map[realKey] = { base: json, baseJson: json, hash: sha1(json), kbase: rec ? rec.kbase : '' };
        touched = true; report.applied++;
        return;
      }
      const kodexK = mdToMarkup(pt.md, { mention: res.mention, check: res.check, stats });
      const before = kuratorNow(c, entity, pt.base, rec, ecp).text;
      const hash = sha1(pt.md);
      let assignTo = null, titleX = pt.title;
      if (pt.assignee) { const who = resolveAssignee(c, res, pt.assignee); if (who) assignTo = who.id; else if (pt.assignee.name) titleX = `${pt.title} (${pt.assignee.name})`; }
      if (row.choice === 'kodex') {
        const w = writeText(c, entity, Object.assign({}, row, { base: pt.base, module: pt.module, assignTo }), kodexK, rec, ecp, titleX);
        k.map[realKey] = Object.assign({ base: pt.md, hash, kbase: kuratorNow(c, entity, pt.base, { moduleId: w.moduleId }, ecp).text != null ? kuratorNow(c, entity, pt.base, { moduleId: w.moduleId }, ecp).text : (w.written != null ? w.written : kodexK) }, w.moduleId ? { moduleId: w.moduleId } : {});
        if (pt.base === 'summary') k.map[realKey].kbase = entity.summary;
      } else if (row.choice === 'both') {
        const merged = `${before || ''}\n\n^^From Kodex^^\n${kodexK}`.trim();
        const w = writeText(c, entity, Object.assign({}, row, { base: pt.base, module: pt.module, assignTo }), merged, rec, ecp, titleX);
        k.map[realKey] = Object.assign({ base: pt.md, hash, kbase: before || '' }, w.moduleId ? { moduleId: w.moduleId } : {});
      } else { // keep Kurator: remember Kodex as the new ancestor, leave our text alone
        const m = rec && rec.moduleId ? rec.moduleId : (before != null && pt.base === 'description' ? (descriptionAt(c, entity.id, ecp) || {}).id : null);
        k.map[realKey] = Object.assign({ base: pt.md, hash, kbase: rec ? rec.kbase : '' }, m ? { moduleId: m } : {});
      }
      if (pt && pt.readonly && k.map[realKey]) k.map[realKey].readonly = true;
      touched = true; report.applied++;
    });
    // image
    const img = pe.image && (pe.image.path || pe.image.file) ? pe.image : null;
    const imgSrc = img || (pe.cover && (pe.cover.path || pe.cover.file) ? pe.cover : null);
    if (imgSrc && !entity.image) report.pendingImages.push({ entityId: entity.id, path: imgSrc.path || null, file: imgSrc.file || null });
    if (touched && !isNew) report.updated.push(entity.name);
    k.importedAt = new Date().toISOString();
  });
  applyCollections(c, pkg, plan, idMap, report);
  _enc.relinkEntries(c, (e) => (ext(e) || {}).id);
  report.checkpointId = cpId;
  report.idMap = idMap;
  return report;
}

function applyPresence(c, pe, entity, cpId, res, k, realKey, report, pkg) {
  const want = (((pe.targets || {}).presence || {}).value || []).concat(extraPresence(pe, pkg || { entities: [] })).map((id) => res.byKodex[id]).filter(Boolean);
  let b = presenceBlock(c, entity.id, cpId);
  if (!b) b = _dm.createArrivalBlock(c, { locationId: entity.id, timeId: cpId });
  if (!Array.isArray(b.presence)) b.presence = [];
  want.forEach((id) => { if (!b.presence.includes(id)) b.presence.push(id); });
  k.map[realKey] = { base: want.slice(), hash: sha1(canonical(want)), kbase: '' };
}

// --- Kurator -> Kodex -----------------------------------------------------------
function buildKuratorExport(campaign, options) {
  const c = campaign;
  const opt = options || {};
  const onlyChanged = opt.onlyChanged !== false;
  const ids = opt.entityIds ? new Set(opt.entityIds) : null;
  const entities = [];
  const commits = [];
  const droppedAll = {};
  const cpList = sortedCheckpoints(c);
  const lastCp = cpList.length ? cpList[cpList.length - 1].id : null;
  const nameOf = (id) => { const e = c.entities[id]; if (!e) return null; const k = ext(e); return { name: e.name, kodexId: k ? k.id : null }; };
  const usedChecks = new Set();
  const checkOf = (id) => {
    const ck = (c.dcChecks || []).find((x) => x.id === id);
    if (!ck) return null;
    usedChecks.add(id);
    return { label: _cond.dcCheckLabel(ck), id: (cext(ck) && cext(ck).id) || ck.id };
  };
  // modules Kodex already owns on ANY entity (a dialog written on a location but spoken by an NPC is assigned to the NPC)
  const allMapped = new Set();
  Object.values(c.entities).forEach((e) => { const kk = ext(e); if (kk && kk.map) Object.values(kk.map).forEach((r) => { if (r && r.moduleId) allMapped.add(r.moduleId); }); });
  Object.values(c.entities).forEach((entity) => {
    if (entity.type !== 'npc' && entity.type !== 'location') return;
    if (ids && !ids.has(entity.id)) return;
    const k = ext(entity);
    const map = k && k.map ? k.map : {};
    const stats = droppedAll;
    const md = (t) => markupToMd(t, { nameOf, checkOf, mentions: k && k.mentions, stats });
    const targets = {};
    const sent = [];
    function offer(key, kind, nowText, extra, rec) {
      const markdown = kind === 'statblock' ? null : md(nowText);
      const hash = kind === 'statblock' ? sha1(canonical(extra.value)) : sha1(markdown);
      const changed = !rec || trim(nowText) !== trim(rec.kbase);
      if (onlyChanged && !changed) return;
      if (kind !== 'statblock' && !trim(nowText) && !rec) return;
      const t = Object.assign(kind === 'statblock' ? { value: extra.value } : { markdown }, { hash, base: rec ? rec.hash || null : null }, extra.title ? { title: extra.title } : {});
      targets[key] = t;
      sent.push({ key, kbase: nowText, base: kind === 'statblock' ? canonical(extra.value) : markdown, hash, moduleId: extra.moduleId });
    }
    offer('summary', 'text', entity.summary || '', {}, map.summary);
    _cc.profileFieldsFor(entity.type).forEach((f) => { if (!(map[`profile.${f.key}`] || {}).readonly) offer(`profile.${f.key}`, 'text', (entity.profile || {})[f.key] || '', {}, map[`profile.${f.key}`]); });
    if (entity.type === 'npc' && canonicalStatblock(entity)) {
      const sbRec = map.statblock ? { hash: map.statblock.hash, kbase: map.statblock.kbase } : null;
      const nowJ = canonicalStatblock(entity);
      const t = { value: _cc.sanitizeStatblock(_cc.getStatblock(entity)), hash: sha1(canonical(_cc.sanitizeStatblock(_cc.getStatblock(entity)))), base: sbRec ? sbRec.hash : null };
      if (!onlyChanged || !sbRec || trim(nowJ) !== trim(sbRec.kbase)) {
        targets.statblock = t;
        sent.push({ key: 'statblock', kbase: nowJ, base: canonical(t.value), hash: t.hash });
      }
    }
    // mapped modules
    const mappedModules = new Set();
    Object.keys(map).forEach((key) => {
      const rec = map[key];
      if (!rec || !rec.moduleId) return;
      mappedModules.add(rec.moduleId);
      const m = moduleOf(c, rec.moduleId);
      if (!m) return;
      const base = key.replace(/@.*$/, '');
      if (/^event:/.test(key) || base === 'note:extraStatblocks') return;
      if (rec.readonly) return;
      offer(base, 'text', moduleText(m), Object.assign({ moduleId: m.id }, /^(topic|beat):[tikd]_/.test(base) ? { title: moduleTitle(m) } : {}), rec);
    });
    // unmapped general notes -> one "Notes" section; unmapped topics / sections -> their own unknown-role section
    const mine = (c.assignments || []).filter((a) => a.entityId === entity.id).map((a) => ({ a, m: moduleOf(c, a.moduleId) })).filter((x) => x.m && !mappedModules.has(x.m.id) && !allMapped.has(x.m.id));
    const gen = mine.filter((x) => x.m.type === 'note' && !x.a.timeId).sort((p, q) => (p.a.order || 0) - (q.a.order || 0));
    if (gen.length) {
      const joined = gen.map((x) => trim(x.m.text)).filter(Boolean).join('\n\n');
      offer('note:notes', 'text', joined, { title: 'Notes', moduleId: null }, map['note:notes']);
    }
    mine.filter((x) => x.m.type === 'topic' && entity.type === 'npc').forEach((x) => offer(`topic:k_${x.m.id}`, 'text', x.m.text || '', { title: moduleTitle(x.m), moduleId: x.m.id }, null));
    if (entity.type === 'location') {
      mine.filter((x) => x.m.type === 'beat').forEach((x) => offer(`beat:k_${x.m.id}`, 'text', x.m.text || '', { title: moduleTitle(x.m), moduleId: x.m.id }, null));
      if (!k) {
        const d = mine.filter((x) => x.m.type === 'description').sort((p, q) => String(q.a.timeId).localeCompare(String(p.a.timeId)))[0];
        if (d) offer('description', 'text', d.m.html || '', { title: 'Description', moduleId: d.m.id }, null);
      }
    }
    if (!Object.keys(targets).length && k) return;
    if (!Object.keys(targets).length && onlyChanged) return;
    const prof = {};
    _cc.profileFieldsFor(entity.type).forEach((f) => { if ((entity.profile || {})[f.key]) prof[f.key] = md(entity.profile[f.key]); });
    entities.push({ kuratorId: entity.id, kodexId: k ? k.id : null, kind: _enc.isEncounter(entity) ? 'encounter' : entity.type, name: entity.name, summary: md(entity.summary || ''), profile: prof, isNew: !k, targets });
    commits.push({ entityId: entity.id, sent });
  });
  // DC checks: the ones the sent texts link to, plus every linked check that changed
  const checkSent = [];
  const sendable = (c.dcChecks || []).filter((ck) => cext(ck) || usedChecks.has(ck.id));
  const queue = sendable.map((ck) => ck.id).filter((id) => !ids || usedChecks.has(id) || (opt.checkIds && opt.checkIds.includes(id)));
  const done = new Set();
  const mdOf = (t) => markupToMd(t, { nameOf, checkOf, stats: droppedAll });
  while (queue.length) {
    const id = queue.shift();
    if (done.has(id)) continue;
    done.add(id);
    const ck = (c.dcChecks || []).find((x) => x.id === id);
    if (!ck) continue;
    const rec = cext(ck);
    const raw = canonical(kuratorCheckDoc(ck));
    if (onlyChanged && rec && raw === rec.kbase) continue;
    const doc = kuratorCheckDoc(ck, mdOf);
    checkSent.push({ ck, doc, raw, rec, out: {
      kuratorId: ck.id, kodexId: rec ? rec.id : null, name: doc.name, checkType: ck.checkType, mode: ck.mode === 'scale' || ck.mode === 'passfail' ? ck.mode : null,
      stackTiers: doc.stackTiers, allowBoth: doc.allowBoth, table: doc.table, conditions: doc.conditions, base: rec ? rec.hash || null : null
    } });
    usedChecks.forEach((u) => { if (!done.has(u)) queue.push(u); });
  }
  const pkg = {
    format: EXPORT_FORMAT, version: 1, schema: 2, app: 'kurator', exportedAt: new Date().toISOString(),
    source: { app: 'Astratera Kurator', version: opt.appVersion || '', campaign: { id: opt.campaignId || '', name: opt.campaignName || '' }, workspace: opt.workspace || '' },
    entities, dcChecks: checkSent.map((x) => x.out), warnings: Object.keys(droppedAll).length ? [`Kurator-only markup removed: ${Object.entries(droppedAll).map(([a, n]) => `${a} ×${n}`).join(', ')}`] : []
  };
  // after a successful transfer: remember what Kodex now holds. response: { ids: { kuratorId: kodexId } }
  function commit(response) {
    const idsBack = (response && response.ids) || {};
    // Kodex creates a check it has never seen with id = our id, so kodexId == kuratorId from then on.
    checkSent.forEach(({ ck, doc, raw, rec, out }) => {
      const base = canonical(Object.assign({}, doc, { mode: doc.mode }));
      ck.external = Object.assign({}, ck.external || {}, { kodex: Object.assign({}, rec || {}, { id: idsBack[ck.id] || (rec && rec.id) || ck.id, workspace: opt.workspace || (rec && rec.workspace) || '', base, hash: sha1(base), kbase: raw }) });
    });
    commits.forEach(({ entityId, sent }) => {
      const entity = c.entities[entityId];
      if (!entity) return;
      let k = ext(entity);
      if (!k && idsBack[entityId]) k = ensureExt(entity, idsBack[entityId], opt.workspace || '');
      if (!k) return;
      sent.forEach((s) => {
        const key = s.key;
        k.map[key] = Object.assign({}, k.map[key] || {}, { base: s.base, hash: s.hash, kbase: s.kbase }, s.moduleId ? { moduleId: s.moduleId } : {});
        if (key === 'statblock') k.map[key].baseJson = s.base;
      });
    });
  }
  return { pkg, commit };
}

const api = {
  IMPORT_FORMAT, EXPORT_FORMAT, NEW_CP,
  sha1, canonical, mdToMarkup, markupToMd, statblockText,
  validatePackage, planImport, applyImport, buildKuratorExport, matchEntity, packageTargets
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.KodexSync = api;
}

})();

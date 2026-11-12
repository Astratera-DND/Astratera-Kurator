// Kodex 0.29 dialog sections with a speaker: topic:d_<id> on a location / encounter / NPC page, assigned to the speaking NPC.
const assert = require('assert');
const DM = require('../src/dataModel');
const KS = require('../src/kodexSync');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
function fresh() { const c = DM.emptyCampaign(); DM.createCheckpoint(c, { label: 'Day 1' }); return c; }
function imp(c, pkg) { const plan = KS.planImport(c, pkg, {}); return { plan, report: KS.applyImport(c, pkg, plan, {}) }; }
const D = (extra) => Object.assign({ markdown: '> Setzt euch dazu!', hash: 'h1', title: 'Verhör', toggle: true, dialog: true }, extra);
function pkg(assignee, opts) {
  const o = opts || {};
  const ents = [{ id: 'loc1', kuratorId: null, kind: 'location', type: 'location', role: 'root', name: 'Rust Bar', profile: {}, sections: [], targets: { 'topic:d_k3x9q2ab': D({ assignee }) } }];
  if (!o.noNpc) ents.push({ id: 'npc_rendok', kuratorId: o.rendokKuratorId || null, kind: 'npc', type: 'npc', role: 'resident', name: 'Rendok', profile: {}, sections: [], targets: { summary: { markdown: 'Barkeeper', hash: 'h2' } } });
  return { format: 'astratera-kodex-export', version: 2, schema: 2, app: 'kodex', exportedAt: '2026-11-12T00:00:00Z', source: { app: 'Astratera Kodex', version: '0.29.0', workspace: 'W' }, root: 'loc1', scope: { rootId: 'loc1', entityIds: ents.map((e) => e.id) }, groups: [], entities: ents };
}
const npcOf = (c, name) => Object.values(c.entities).find((e) => e.type === 'npc' && e.name === name);
const topicsOf = (c, entityId) => (c.assignments || []).filter((a) => a.entityId === entityId).map((a) => c.contentModules.find((m) => m.id === a.moduleId)).filter((m) => m && m.type === 'topic');

test('dialog on a location is assigned to the speaking NPC (found in the same package)', () => {
  const c = fresh(); const { plan, report } = imp(c, pkg({ id: 'npc_rendok', name: 'Rendok', kuratorId: null }));
  const row = plan.entities.find((e) => e.kodexId === 'loc1').targets.find((t) => t.key === 'topic:d_k3x9q2ab');
  assert.ok(row && /Verhör/.test(row.label) && /Rendok/.test(row.label), row && row.label);
  const rendok = npcOf(c, 'Rendok'); const t = topicsOf(c, rendok.id);
  assert.strictEqual(t.length, 1); assert.strictEqual(t[0].name, 'Verhör'); assert.ok(t[0].text.includes('Setzt euch dazu'));
  const loc = Object.values(c.entities).find((e) => e.name === 'Rust Bar');
  assert.strictEqual(topicsOf(c, loc.id).length, 0);                                     // not on the location
  assert.strictEqual(loc.external.kodex.map['topic:d_k3x9q2ab'].moduleId, t[0].id);      // the sync record sits on the page it was written on
});

test('matching: kuratorId first, then Kodex id, then name', () => {
  const c = fresh(); const a = DM.createEntity(c, { type: 'npc', name: 'Someone else' }); const b = DM.createEntity(c, { type: 'npc', name: 'Rendok' });
  imp(c, pkg({ id: 'zzz', name: 'Rendok', kuratorId: a.id }, { noNpc: true }));
  assert.strictEqual(topicsOf(c, a.id).length, 1); assert.strictEqual(topicsOf(c, b.id).length, 0);
  const c2 = fresh(); const r2 = DM.createEntity(c2, { type: 'npc', name: 'Rendok' });
  imp(c2, pkg({ id: 'nobody', name: 'rendok', kuratorId: null }, { noNpc: true }));
  assert.strictEqual(topicsOf(c2, r2.id).length, 1);                                       // by name, case-insensitive
});

test('speaker not known: the topic stays on the location and the name is in the title', () => {
  const c = fresh(); const { plan } = imp(c, pkg({ id: 'gone', name: 'Ghost', kuratorId: null }, { noNpc: true }));
  const row = plan.entities[0].targets.find((t) => t.key === 'topic:d_k3x9q2ab');
  assert.ok(/not in Kurator/.test(row.label), row.label);
  const loc = Object.values(c.entities).find((e) => e.name === 'Rust Bar'); const t = topicsOf(c, loc.id);
  assert.strictEqual(t.length, 1); assert.ok(/Ghost/.test(t[0].name), t[0].name);
});

test('re-import is unchanged; an edit in Kodex updates the same topic', () => {
  const c = fresh(); imp(c, pkg({ id: 'npc_rendok', name: 'Rendok' }));
  const p = KS.planImport(c, pkg({ id: 'npc_rendok', name: 'Rendok' }), {});
  assert.ok(!p.counts.new && !p.counts.conflict && !p.counts.kodex, JSON.stringify(p.counts));
  const k2 = pkg({ id: 'npc_rendok', name: 'Rendok' }); k2.entities[0].targets['topic:d_k3x9q2ab'].markdown = '> Neue Zeile'; k2.entities[0].targets['topic:d_k3x9q2ab'].hash = 'h9';
  imp(c, k2);
  const t = topicsOf(c, npcOf(c, 'Rendok').id); assert.strictEqual(t.length, 1); assert.ok(t[0].text.includes('Neue Zeile'));
});

test('export: the dialog goes back under the page it was written on with its title; not twice under the NPC', () => {
  const c = fresh(); imp(c, pkg({ id: 'npc_rendok', name: 'Rendok' }));
  const ex = KS.buildKuratorExport(c, { campaignId: 'x', campaignName: 'x', onlyChanged: false });
  const loc = ex.pkg.entities.find((e) => e.name === 'Rust Bar'); const npc = ex.pkg.entities.find((e) => e.name === 'Rendok');
  assert.strictEqual(loc.targets['topic:d_k3x9q2ab'].title, 'Verhör');
  assert.ok(!Object.keys(npc.targets).some((k) => /^topic:/.test(k)), Object.keys(npc.targets).join(','));
});

test('export: topics made in Kurator always carry a title, also after the first send', () => {
  const c = fresh(); const n = DM.createEntity(c, { type: 'npc', name: 'Ana' });
  const named = DM.createContentModule(c, { type: 'topic', name: 'Ask about the signal', text: 'Hello' }); DM.createAssignment(c, { moduleId: named.id, entityId: n.id, timeId: null });
  const blank = DM.createContentModule(c, { type: 'topic', name: '', text: '- The hum stopped' }); DM.createAssignment(c, { moduleId: blank.id, entityId: n.id, timeId: null });
  let ex = KS.buildKuratorExport(c, { campaignId: 'x', campaignName: 'x', onlyChanged: false });
  let tg = ex.pkg.entities[0].targets;
  assert.strictEqual(tg[`topic:k_${named.id}`].title, 'Ask about the signal'); assert.strictEqual(tg[`topic:k_${blank.id}`].title, 'The hum stopped');
  ex.commit({ ids: { [n.id]: 'K1' } });
  ex = KS.buildKuratorExport(c, { campaignId: 'x', campaignName: 'x', onlyChanged: false });
  tg = ex.pkg.entities[0].targets;
  assert.strictEqual(tg[`topic:k_${named.id}`].title, 'Ask about the signal');             // used to be dropped once the topic was linked
  assert.strictEqual(tg[`topic:k_${blank.id}`].title, 'The hum stopped');
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }

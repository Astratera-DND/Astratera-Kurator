const assert = require('assert');
const DM = require('../src/dataModel');
const E = require('../src/encounters');
const KS = require('../src/kodexSync');
const Q = require('../src/query');
const sample = require('./fixtures/kodex-encounter-sample.json');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
const byName = (c, n) => Object.values(c.entities).find((e) => e.name === n);
function fresh() { const c = DM.emptyCampaign(); DM.createCheckpoint(c, { label: 'Day 1' }); return c; }
function imp(c, pkg, tweak) { const plan = KS.planImport(c, pkg, {}); if (tweak) tweak(plan); return KS.applyImport(c, pkg, plan, {}); }

test('dice rule matches Kodex', () => {
  const t = (n, die, kind, note) => { const d = E.diceFor(n); assert.strictEqual(d.die, die, `n=${n}`); assert.strictEqual(d.kind, kind, `n=${n}`); if (note !== undefined) assert.strictEqual(d.note, note, `n=${n}`); return d; };
  t(0, 0, 'none'); t(1, 0, 'none');
  assert.deepStrictEqual(t(2, 4, 'group').ranges, [{ from: 1, to: 2 }, { from: 3, to: 4 }]);
  assert.deepStrictEqual(t(3, 6, 'group').ranges, [{ from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 }]);
  t(4, 4, 'exact'); t(5, 10, 'group'); t(6, 6, 'exact'); t(10, 10, 'exact'); t(20, 20, 'exact');
  t(7, 8, 'reroll', 'Reroll 8'); t(9, 10, 'reroll', 'Reroll 10'); t(11, 12, 'reroll', 'Reroll 12'); t(21, 100, 'reroll', 'Reroll 22–100');
  t(101, 100, 'reroll', 'More than 100 encounters: split the collection');
});

test('rolling hits the right row and handles reroll gaps', () => {
  const c = fresh();
  const col = E.createCollection(c, { name: 'X' });
  for (let i = 0; i < 7; i++) { const e = DM.createEntity(c, { type: 'location', name: 'e' + i }); e.encounter = true; E.addEntry(c, col.id, e.id); }
  const table = E.tableOf(c, col);
  assert.strictEqual(table.dice.die, 8);
  assert.strictEqual(E.rollOn(table, () => 0).row.index, 1);
  assert.strictEqual(E.rollOn(table, () => 0.99).row, null);       // 8 = roll again
  assert.strictEqual(E.rollOn(table, () => 0.99).roll, 8);
});

test('import creates encounters, hidden checkpoint, presence and the collection', () => {
  const c = fresh(); const r = imp(c, clone(sample));
  assert.deepStrictEqual(r.collectionsCreated, ['Road to Karthy']);
  const e1 = byName(c, 'Broken Caravan');
  assert.ok(E.isEncounter(e1)); assert.strictEqual(e1.icon, 'wagon');
  assert.ok(c.checkpoints.some(E.isEncounterCp));
  const blk = c.blocks.find((b) => b.locationId === e1.id);
  assert.strictEqual(blk.timeId, E.RESERVED_CP_ID);
  assert.ok(blk.presence.includes(byName(c, 'Doctor').id) && blk.presence.includes(byName(c, 'Rust Gate').id));
  const t = E.tableOf(c, c.encounterCollections[0]);
  assert.deepStrictEqual(t.rows.map((x) => [x.range, x.name]), [['1–2', 'Broken Caravan'], ['3–4', 'Toll Bridge'], ['5–6', 'Hungry Wolves']]);
  assert.strictEqual(E.routeText(c.encounterCollections[0].route), 'Rust Gate → Old Mill → Dura Harbour · 3 days, marshy');
  const gate = byName(c, 'Rust Gate'); assert.ok(!E.isEncounter(gate));
});

test('the encounter checkpoint never appears among the normal checkpoints', () => {
  const c = fresh(); imp(c, clone(sample));
  E.setScope('campaign');
  assert.ok(!Q.sortedCheckpoints(c).some(E.isEncounterCp));
  assert.strictEqual(Q.sortedCheckpoints(c).length, 1);
  E.setScope('encounter');
  assert.deepStrictEqual(Q.sortedCheckpoints(c).map((x) => x.id), [E.RESERVED_CP_ID]);
  E.setScope('campaign');
});

test('re-import is idempotent, Kodex changes flow, Kurator edits conflict', () => {
  const c = fresh(); imp(c, clone(sample));
  const again = KS.planImport(c, clone(sample), {});
  assert.strictEqual(again.counts.unchanged, 10); assert.ok(!again.counts.conflict && !again.counts.new);
  const pkg = clone(sample);
  pkg.encounterCollections[0].entries.push({ index: 4, from: 4, to: 4, encounterId: 'e4', name: 'Late One', inPackage: false });
  pkg.encounterCollections[0].dice = { label: 'd4', die: 4, count: 4, kind: 'exact', note: '' };
  const p = KS.planImport(c, pkg, {});
  assert.strictEqual(p.collections[0].status, 'kodex');
  KS.applyImport(c, pkg, p, {});
  const col = c.encounterCollections[0];
  assert.strictEqual(col.entries.length, 4); assert.strictEqual(col.entries[3].encounterId, null);
  assert.strictEqual(E.tableOf(c, col).rows[3].name, 'Late One');
  // the late encounter arrives in a later import and fills its slot
  const late = clone(sample); late.root = 'e4'; late.encounterCollections = [];
  late.entities = [Object.assign(clone(sample.entities[2]), { id: 'e4', name: 'Late One' })];
  KS.applyImport(c, late, KS.planImport(c, late, {}), {});
  assert.ok(E.tableOf(c, col).rows[3].encounterId);
  // edit in Kurator, then Kodex changes too -> conflict
  col.entries.pop();
  const pkg2 = clone(pkg); pkg2.encounterCollections[0].name = 'Road to Karthy 2';
  assert.strictEqual(KS.planImport(c, pkg2, {}).collections[0].status, 'conflict');
});

test('conflict stays open until chosen; keeping Kurator leaves the table alone', () => {
  const c = fresh(); imp(c, clone(sample));
  const col = c.encounterCollections[0]; col.entries.pop();
  const pkg = clone(sample); pkg.encounterCollections[0].name = 'Renamed';
  const plan = KS.planImport(c, pkg, {});
  assert.strictEqual(plan.collections[0].choice, null);
  assert.strictEqual(KS.applyImport(c, pkg, plan, {}).conflictsOpen.length, 1);
  plan.collections[0].choice = 'skip';
  KS.applyImport(c, pkg, plan, {});
  assert.strictEqual(col.entries.length, 2); assert.strictEqual(col.name, 'Road to Karthy');
});

test('encounters are exported as kind encounter and normal places are not touched', () => {
  const c = fresh(); imp(c, clone(sample));
  const x = KS.buildKuratorExport(c, { onlyChanged: false }).pkg;
  assert.ok(x.entities.filter((e) => e.kind === 'encounter').length === 3);
  assert.ok(!x.entities.some((e) => e.kind === 'location' && e.name === 'Broken Caravan'));
});

test('an encounter and a place with the same name stay separate', () => {
  const c = fresh(); const loc = DM.createEntity(c, { type: 'location', name: 'Broken Caravan' });
  imp(c, clone(sample));
  assert.ok(!E.isEncounter(loc));
  assert.strictEqual(Object.values(c.entities).filter((e) => e.name === 'Broken Caravan').length, 2);
});

test('a page that is not imported stays readable inside bold text', () => {
  const c = fresh(); imp(c, clone(sample));
  const d = Object.values(c.entities).find((e) => e.name === 'Broken Caravan');
  const m = c.contentModules.find((x) => x.type === 'description' && /Brass Lamp/.test(x.html));
  assert.ok(m && !/\*\*\*\*/.test(m.html), m && m.html);
});

test('an encounter with content but no present-here list still shows in Play', () => {
  const c = fresh(); imp(c, clone(sample));
  const w = byName(c, 'Hungry Wolves');
  c.blocks = c.blocks.filter((b) => b.locationId !== w.id);          // as in campaigns imported before this fix
  E.setScope('encounter');
  const v = require('../src/query').getLocationView(c, w.id, E.RESERVED_CP_ID);
  E.setScope('campaign');
  assert.ok(v.arrival && /Eyes in the dark/.test(v.html), v.html);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }

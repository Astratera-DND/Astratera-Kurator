const assert = require('assert');
const DM = require('../src/dataModel');
const KS = require('../src/kodexSync');
const Conditions = require('../src/conditions');
const sample = require('./fixtures/kodex-dccheck-sample.json');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
function fresh() { const c = DM.emptyCampaign(); DM.createCheckpoint(c, { label: 'Day 1' }); return c; }
function imp(c, pkg, tweak) { const plan = KS.planImport(c, pkg, {}); if (tweak) tweak(plan); return KS.applyImport(c, pkg, plan, {}); }
const byKodex = (c, id) => c.dcChecks.find((x) => x.external && x.external.kodex.id === id);

test('Kodex checks import: scale table and pass/fail ladder, text links become [[DCCHECK]]', () => {
  const c = fresh(); const r = imp(c, clone(sample));
  assert.deepStrictEqual(r.checksCreated.sort(), ['Notice the hum', 'Rusted frame']);
  const hum = byKodex(c, 'dcc_hum01'), frame = byKodex(c, 'dcc_frame1');
  assert.strictEqual(hum.mode, 'scale'); assert.deepStrictEqual(hum.table.map((t) => [t.dc, t.text]), [[10, 'You hear a faint hum.'], [15, 'It repeats every few seconds.']]);
  assert.strictEqual(frame.mode, 'passfail');
  assert.deepStrictEqual(frame.conditions.map((x) => `${x.trigger}:${x.occurrence}`), ['success:1', 'failure:1', 'failure:2', 'nat1:1', 'nat20:1']);
  assert.ok(frame.conditionId && Conditions.byId(c, frame.conditionId));       // the derived dice condition exists
  assert.deepStrictEqual(frame.rollLog, []);
  const desc = c.contentModules.find((m) => m.type === 'description');
  assert.ok(desc.html.includes(`[[DCCHECK:${hum.id}]]`), desc.html);
  const note = c.contentModules.find((m) => m.type === 'note');
  assert.ok(note.text.includes(`[[DCCHECK:${frame.id}]]`));
});

test('re-import changes nothing and keeps the roll log', () => {
  const c = fresh(); imp(c, clone(sample));
  const frame = byKodex(c, 'dcc_frame1'); frame.rollLog.push({ id: 'roll_1', value: 17, at: 'x' });
  const p = KS.planImport(c, clone(sample), {});
  assert.deepStrictEqual(p.dcChecks.map((x) => x.status), ['unchanged', 'unchanged']);
  assert.ok(!p.counts.new && !p.counts.conflict);
  assert.strictEqual(frame.rollLog.length, 1);
});

test('a change in Kodex flows, an edit in Kurator is kept, both is a conflict', () => {
  const c = fresh(); imp(c, clone(sample));
  const pkg = clone(sample); pkg.dcChecks[0].table[0].markdown = 'A loud hum.';
  let p = KS.planImport(c, pkg, {});
  assert.strictEqual(p.dcChecks[0].status, 'kodex');
  KS.applyImport(c, pkg, p, {});
  const hum = byKodex(c, 'dcc_hum01'); assert.strictEqual(hum.table[0].text, 'A loud hum.');
  assert.strictEqual(hum.table.length, 2); assert.ok(hum.rollLog && hum.conditionId);
  hum.table[1].text = 'Mine.';
  assert.strictEqual(KS.planImport(c, pkg, {}).dcChecks[0].status, 'kurator');
  const pkg2 = clone(pkg); pkg2.dcChecks[0].table[0].markdown = 'Changed again.';
  p = KS.planImport(c, pkg2, {});
  assert.strictEqual(p.dcChecks[0].status, 'conflict');                    // the whole check is the unit: both sides changed it
  const pkg3 = clone(pkg2); pkg3.dcChecks[0].table[1].markdown = 'Theirs.';
  p = KS.planImport(c, pkg3, {});
  assert.strictEqual(p.dcChecks[0].status, 'conflict'); assert.strictEqual(p.dcChecks[0].choice, null);
  assert.strictEqual(KS.applyImport(c, pkg3, p, {}).conflictsOpen.length, 1);
  assert.strictEqual(hum.table[1].text, 'Mine.');                           // nothing overwritten
});

test('an unknown check type is skipped with a note, never invented', () => {
  const c = fresh(); const pkg = clone(sample); pkg.dcChecks[0].checkType = 'basketWeaving';
  const r = imp(c, pkg);
  assert.strictEqual(c.dcChecks.length, 1);
  assert.ok(r.warnings.some((w) => /basketWeaving/.test(w)));
});

test('export sends checks with the Kodex hash as base and kodex-check links with the Kodex id', () => {
  const c = fresh(); imp(c, clone(sample));
  const x = KS.buildKuratorExport(c, { onlyChanged: false }).pkg;
  assert.deepStrictEqual(x.dcChecks.map((d) => [d.kodexId, d.base]), [['dcc_hum01', sample.dcChecks[0].hash], ['dcc_frame1', sample.dcChecks[1].hash]]);
  const desc = x.entities[0].targets.description.markdown;
  assert.ok(desc.includes('[DC check: Notice the hum](kodex-check:dcc_hum01)'), desc);
  assert.ok(!('rollLog' in x.dcChecks[0]) && !('conditionId' in x.dcChecks[0]));
  assert.strictEqual(KS.buildKuratorExport(c, {}).pkg.dcChecks.length, 0);      // nothing changed since import
});

test('a check edited in Kurator is sent once; the new hash is remembered', () => {
  const c = fresh(); imp(c, clone(sample));
  byKodex(c, 'dcc_hum01').table[0].text = 'You hear a loud hum.';
  const ex = KS.buildKuratorExport(c, {});
  assert.strictEqual(ex.pkg.dcChecks.length, 1);
  assert.strictEqual(ex.pkg.dcChecks[0].base, sample.dcChecks[0].hash);
  assert.strictEqual(ex.pkg.dcChecks[0].table[0].markdown, 'You hear a loud hum.');
  ex.commit({});
  assert.strictEqual(KS.buildKuratorExport(c, {}).pkg.dcChecks.length, 0);
  const again = clone(sample); again.dcChecks[0].table[0].markdown = 'You hear a loud hum.'; again.dcChecks[0].hash = byKodex(c, 'dcc_hum01').external.kodex.hash;
  assert.strictEqual(KS.planImport(c, again, {}).dcChecks[0].status, 'unchanged');
});

test('a check made in Kurator goes out with kodexId null and is linked by its own id afterwards', () => {
  const c = fresh();
  const e = DM.createEntity(c, { type: 'npc', name: 'Vlad' });
  const ck = DM.createDCCheck(c, { name: 'Pick the lock', checkType: 'sleightOfHand' }); DM.addDCTableRow(c, ck.id, { dc: 12, text: 'Click.' });
  const m = DM.createContentModule(c, { type: 'note', name: 'x', text: `Locked. [[DCCHECK:${ck.id}]]` }); DM.createAssignment(c, { moduleId: m.id, entityId: e.id, timeId: null });
  const ex = KS.buildKuratorExport(c, {});
  assert.deepStrictEqual(ex.pkg.dcChecks.map((d) => [d.kuratorId, d.kodexId, d.base]), [[ck.id, null, null]]);
  assert.ok(ex.pkg.entities[0].targets['note:notes'].markdown.includes(`kodex-check:${ck.id}`));
  ex.commit({});
  assert.strictEqual(ck.external.kodex.id, ck.id);
  assert.strictEqual(KS.buildKuratorExport(c, {}).pkg.dcChecks.length, 0);
  // Kodex later sends it back under the same id: linked, nothing new
  const back = { format: 'astratera-kodex-export', schema: 2, entities: [], dcChecks: [{ id: ck.id, kuratorId: ck.id, name: 'Pick the lock', checkType: 'sleightOfHand', mode: 'scale', stackTiers: true, allowBoth: false, table: [{ dc: 12, markdown: 'Click.' }], conditions: [] }] };
  const p = KS.planImport(c, back, {});
  assert.strictEqual(p.dcChecks[0].link.kuratorId, ck.id); assert.strictEqual(p.dcChecks[0].status, 'unchanged');
});

test('a check that Kurator already has is matched by name and type, never duplicated', () => {
  const c = fresh(); const mine = DM.createDCCheck(c, { name: 'Notice the hum', checkType: 'perception' });
  DM.addDCTableRow(c, mine.id, { dc: 10, text: 'You hear a faint hum.' }); DM.addDCTableRow(c, mine.id, { dc: 15, text: 'It repeats every few seconds.' });
  const p = KS.planImport(c, clone(sample), {});
  assert.strictEqual(p.dcChecks[0].link.kuratorId, mine.id); assert.strictEqual(p.dcChecks[0].status, 'same');
  imp(c, clone(sample));
  assert.strictEqual(c.dcChecks.filter((x) => x.name === 'Notice the hum').length, 1);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }

const assert = require('assert');
const DM = require('../src/dataModel');
const CC = require('../src/characterCard');
const KS = require('../src/kodexSync');
const sample = require('./fixtures/kodex-sample-export.json');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
const byName = (c, n) => Object.values(c.entities).find((e) => e.name === n);
function fresh() { const c = DM.emptyCampaign(); DM.createCheckpoint(c, { label: 'Day 1' }); return c; }
function run(c, pkg, tweak) {
  const plan = KS.planImport(c, pkg, {});
  if (tweak) tweak(plan);
  return { plan, report: KS.applyImport(c, pkg, plan, {}) };
}
function notesOf(c, e, timeId) { return c.assignments.filter((a) => a.entityId === e.id && (a.timeId || null) === (timeId || null)).map((a) => c.contentModules.find((m) => m.id === a.moduleId)); }

test('sha1 matches the hashes Kodex sent', () => {
  sample.entities.forEach((e) => Object.keys(e.targets).forEach((k) => {
    const t = e.targets[k];
    if (typeof t.markdown === 'string') assert.strictEqual(KS.sha1(t.markdown), t.hash, `${e.name} ${k}`);
  }));
  assert.strictEqual(KS.sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});

test('markdown -> Kurator markup', () => {
  const m = KS.mdToMarkup('# Head\n\nSome __bold__ and *it* and `code`.\n\n- one\n  - two\n    - three\n1. a\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[x](https://e.com) [Corps](kodex:abc) ![i](p.png)', { mention: (id, n) => (id === 'abc' ? '[[npc_1]]' : `**${n}**`) });
  assert.ok(m.startsWith('**Head**'));
  assert.ok(m.includes('Some **bold** and *it* and code.'));
  assert.ok(m.includes('- one\n\t- two\n\t\t- three\n- a'));
  assert.ok(m.includes('- a · b') && m.includes('- 1 · 2'));
  assert.ok(m.includes('x (https://e.com) [[npc_1]]'));
  assert.ok(!m.includes('!['));
});

test('Kurator markup -> markdown strips Kurator-only tokens and resolves mentions', () => {
  const stats = {};
  const md = KS.markupToMd('Hi [[npc_a1]] and [[loc_b2]]. [[SAY:npc_a1]]You are early.[[/SAY]] [[DCCHECK:dc_1]][[IF:c:x]]kept[[/IF]] ^^secret^^ _it_\n\t- sub', {
    stats, nameOf: (id) => (id === 'npc_a1' ? { name: 'Grey man', kodexId: 'K1' } : id === 'loc_b2' ? { name: 'Market', kodexId: null } : null)
  });
  assert.ok(md.includes('[Grey man](kodex:K1)') && md.includes('**Market**'));
  assert.ok(md.includes('"You are early."') && md.includes('kept') && !md.includes('[['));
  assert.ok(md.includes('(DM: secret)') && md.includes('*it*') && md.includes('  - sub'));
  assert.ok(stats.kuratorOnly >= 3);
});

test('import into an empty campaign creates entities, groups, content and a stat block', () => {
  const c = fresh();
  const { plan, report } = run(c, sample);
  assert.strictEqual(plan.counts.newEntities, 4);
  assert.deepStrictEqual(report.created.sort(), ['Grey man', 'Hearthhold-47', 'Rusted Spire Market', 'Vladi']);
  const grey = byName(c, 'Grey man'), city = byName(c, 'Hearthhold-47'), market = byName(c, 'Rusted Spire Market'), vladi = byName(c, 'Vladi');
  assert.strictEqual(grey.type, 'npc'); assert.strictEqual(city.type, 'location');
  assert.strictEqual(grey.profile.race, 'Humans (augmented)'); assert.strictEqual(grey.profile.age, 'Mid-fifties');
  assert.ok(grey.profile.history.includes('Signal Corps') && !grey.profile.history.includes('kodex:'));
  assert.strictEqual(city.summary, 'A walled port city built around a fallen tether anchor.');
  const sb = grey.characterCard.statblock;
  assert.strictEqual(sb.skills.Perception, 1); assert.strictEqual(sb.skills.Stealth, 2); assert.strictEqual(sb.skillOverrides.Insight, 9); assert.strictEqual(sb.saveProf.dex, true); assert.strictEqual(sb.ac, 14);
  assert.strictEqual(vladi.characterCard.statblock.actions.startsWith('Unarmed'), true);
  // notes (general) of Grey man: personality, secrets, hooks, body
  const cp = c.checkpoints.find((x) => x.label === 'Day 1').id;
  const gNotes = notesOf(c, grey, null).filter((m) => m.type === 'note').map((m) => m.text);
  assert.ok(gNotes.some((t) => t.startsWith('**Personality**')) && gNotes.some((t) => t.startsWith('**Secrets**')) && gNotes.some((t) => t.startsWith('**Hooks**')));
  const topics = notesOf(c, grey, null).filter((m) => m.type === 'topic');
  assert.strictEqual(topics.length, 1); assert.strictEqual(topics[0].name, 'Dialog'); assert.ok(topics[0].text.includes('- "You are early."'));
  // location description (combined: description + body + atmosphere) and beats at the checkpoint
  const desc = notesOf(c, city, cp).find((m) => m.type === 'description');
  assert.ok(desc.html.includes('Rust-red **scaffolding**') && desc.html.includes('[[' + grey.id + ']]') && desc.html.includes('[[' + vladi.id + ']]'));
  assert.ok(notesOf(c, city, cp).some((m) => m.type === 'beat' && m.name === 'Rumours' && m.text.includes('ghost ship')));
  assert.ok(notesOf(c, city, null).some((m) => m.type === 'note' && m.text.startsWith('**Secrets**')));
  // presence: Grey man + child Market in the city, Vladi in the market
  assert.deepStrictEqual(c.blocks.find((b) => b.kind === 'arrival' && b.locationId === city.id).presence.sort(), [grey.id, market.id].sort());
  assert.deepStrictEqual(c.blocks.find((b) => b.kind === 'arrival' && b.locationId === market.id).presence, [vladi.id]);
  // groups + milestones
  assert.ok(c.entityGroups.some((g) => g.name === 'Hearthhold-47'));
  assert.strictEqual(grey.groupId, c.entityGroups.find((g) => g.name === 'Hearthhold-47').id);
  assert.strictEqual(market.groupId, grey.groupId);
  assert.ok(c.checkpoints.some((x) => x.label === 'Landing at Hearthhold') && c.checkpoints.some((x) => x.label === 'Market robbery'));
  const landing = c.checkpoints.find((x) => x.label === 'Landing at Hearthhold').id;
  assert.ok(notesOf(c, grey, landing).some((m) => m.text.startsWith('**Landing at Hearthhold**')));
  assert.strictEqual(grey.external.kodex.id, '00000000-0000-4000-8000-000000000004');
});

test('importing the same package twice changes nothing', () => {
  const c = fresh();
  run(c, sample);
  const before = JSON.stringify(c);
  const { plan, report } = run(c, sample);
  assert.strictEqual(plan.counts.new || 0, 0); assert.strictEqual(plan.counts.conflict || 0, 0);
  assert.strictEqual(report.created.length, 0);
  const strip = (x) => JSON.stringify(x, (k, v) => (k === 'importedAt' ? undefined : v));
  assert.strictEqual(strip(JSON.parse(before)), strip(c));
});

test('a change in Kodex updates Kurator; a change in Kurator is kept; both -> conflict needs a choice', () => {
  const c = fresh(); run(c, sample);
  const grey = byName(c, 'Grey man');
  const pkg = clone(sample);
  const ge = pkg.entities.find((e) => e.name === 'Grey man');
  ge.targets['profile.age'].markdown = 'Late fifties'; ge.targets['profile.age'].hash = KS.sha1('Late fifties');
  grey.profile.history = 'My own history edit.';                     // Kurator-side edit, Kodex unchanged
  const plan = KS.planImport(c, pkg, {});
  const rows = Object.fromEntries(plan.entities.find((e) => e.name === 'Grey man').targets.map((t) => [t.key, t]));
  assert.strictEqual(rows['profile.age'].status, 'kodex');
  assert.strictEqual(rows['profile.history'].status, 'kurator');
  KS.applyImport(c, pkg, plan, {});
  assert.strictEqual(grey.profile.age, 'Late fifties'); assert.strictEqual(grey.profile.history, 'My own history edit.');
  // conflict
  ge.targets['profile.history'].markdown = 'Kodex history edit.';
  const plan2 = KS.planImport(c, pkg, {});
  const r2 = plan2.entities.find((e) => e.name === 'Grey man').targets.find((t) => t.key === 'profile.history');
  assert.strictEqual(r2.status, 'conflict'); assert.strictEqual(r2.choice, null);
  let rep = KS.applyImport(c, pkg, plan2, {});
  assert.strictEqual(grey.profile.history, 'My own history edit.'); assert.strictEqual(rep.conflictsOpen.length, 1);
  r2.choice = 'both';
  KS.applyImport(c, pkg, plan2, {});
  assert.ok(grey.profile.history.startsWith('My own history edit.') && grey.profile.history.includes('Kodex history edit.'));
  const plan3 = KS.planImport(c, pkg, {});
  assert.strictEqual(plan3.entities.find((e) => e.name === 'Grey man').targets.find((t) => t.key === 'profile.history').status, 'kurator');
});

test('an existing entity with the same name is linked, never overwritten silently', () => {
  const c = fresh();
  const v = DM.createEntity(c, { type: 'npc', name: 'vladi', summary: 'My own summary' });
  const plan = KS.planImport(c, sample, {});
  const pv = plan.entities.find((e) => e.name === 'Vladi');
  assert.strictEqual(pv.link.mode, 'name'); assert.strictEqual(pv.link.kuratorId, v.id);
  assert.strictEqual(pv.targets.find((t) => t.key === 'summary').status, 'conflict');
  KS.applyImport(c, sample, plan, {});
  assert.strictEqual(v.summary, 'My own summary');
  assert.strictEqual(v.profile.appearance, 'Gold tooth, patched cloak.');
  assert.strictEqual(Object.values(c.entities).filter((e) => e.name.toLowerCase() === 'vladi').length, 1);
  pv.link = { mode: 'new' };
  const c2 = fresh(); DM.createEntity(c2, { type: 'npc', name: 'Vladi' });
  const p2 = KS.planImport(c2, sample, {}); p2.entities.find((e) => e.name === 'Vladi').link = { mode: 'new', kuratorId: null };
  KS.applyImport(c2, sample, p2, {});
  assert.strictEqual(Object.values(c2.entities).filter((e) => e.name === 'Vladi').length, 2);
});

test('skip drops an entity entirely; non-NPC/location pages are ignored', () => {
  const c = fresh();
  const pkg = clone(sample); pkg.entities.push({ id: 'x', kind: 'item', name: 'Sword', sections: [], targets: {} });
  const plan = KS.planImport(c, pkg, {});
  assert.ok(plan.warnings.some((w) => w.includes('Sword')));
  plan.entities.find((e) => e.name === 'Vladi').link = { mode: 'skip' };
  KS.applyImport(c, pkg, plan, {});
  assert.ok(!byName(c, 'Vladi') && byName(c, 'Grey man'));
});

test('extra stat blocks become a plain-text note', () => {
  const c = fresh();
  const pkg = clone(sample);
  pkg.entities.find((e) => e.name === 'Vladi').extraStatblocks = [{ name: 'Wolf form', statblock: { ac: 13, hp: 11, cr: '1/4', actions: 'Bite. +4 to hit.' } }];
  run(c, pkg);
  const notes = notesOf(c, byName(c, 'Vladi'), null).map((m) => m.text).join('\n');
  assert.ok(notes.includes('**Wolf form**') && notes.includes('AC 13') && notes.includes('Bite.'));
});

test('export: unchanged imports send nothing; edits, new notes and new entities go back with base hashes', () => {
  const c = fresh(); run(c, sample);
  assert.strictEqual(KS.buildKuratorExport(c, {}).pkg.entities.length, 0);
  const grey = byName(c, 'Grey man');
  grey.profile.age = 'Sixty';
  const note = DM.createContentModule(c, { type: 'note', name: 'n', text: 'Session 3: he lied to us about [[' + byName(c, 'Vladi').id + ']].' });
  DM.createAssignment(c, { moduleId: note.id, entityId: grey.id, timeId: null });
  const fresh1 = DM.createEntity(c, { type: 'npc', name: 'Brand new', summary: 'Made in Kurator' });
  const { pkg, commit } = KS.buildKuratorExport(c, { campaignName: 'Test' });
  assert.strictEqual(pkg.format, 'astratera-kurator-export');
  const pg = pkg.entities.find((e) => e.name === 'Grey man');
  assert.strictEqual(pg.kodexId, '00000000-0000-4000-8000-000000000004');
  assert.strictEqual(pg.targets['profile.age'].markdown, 'Sixty');
  assert.strictEqual(pg.targets['profile.age'].base, KS.sha1('Mid-fifties'));
  assert.ok(pg.targets['note:notes'].markdown.includes('[Vladi](kodex:00000000-0000-4000-8000-000000000005)'));
  assert.ok(!pg.targets.statblock && !pg.targets['profile.history']);
  const pn = pkg.entities.find((e) => e.name === 'Brand new');
  assert.strictEqual(pn.kodexId, null); assert.strictEqual(pn.isNew, true); assert.strictEqual(pn.kuratorId, fresh1.id);
  commit({ ids: { [fresh1.id]: 'NEWKODEX' } });
  assert.strictEqual(fresh1.external.kodex.id, 'NEWKODEX');
  assert.strictEqual(KS.buildKuratorExport(c, {}).pkg.entities.length, 0);
});

test('round trip: text edited in Kurator and sent back restores Kodex page links for non-entities', () => {
  const c = fresh(); run(c, sample);
  const grey = byName(c, 'Grey man');
  grey.profile.history = grey.profile.history + ' Edited.';
  const { pkg } = KS.buildKuratorExport(c, {});
  assert.ok(pkg.entities[0].targets['profile.history'].markdown.includes('[Signal Corps](kodex:00000000-0000-4000-8000-000000000011)'));
});

test('external survives the storage normalizer', () => {
  const c = fresh(); run(c, sample);
  const Storage = require('../src/storage');
  const back = Storage.normalizeCampaign ? Storage.normalizeCampaign(JSON.parse(JSON.stringify(c))) : JSON.parse(JSON.stringify(c));
  assert.ok(byName(back, 'Grey man').external.kodex.map.summary);
});

test('nested places: groups follow the tree, presence per place, quotes arrive as dialog', () => {
  const nested = require('./fixtures/kodex-sample-nested.json');
  const c = fresh(); const { report } = run(c, nested);
  assert.strictEqual(report.created.length, 5);
  const gate = byName(c, 'Liminal Gate'), hosp = byName(c, 'Hospital'), room = byName(c, 'Patient Room'), doc = byName(c, 'Doctor'), nurse = byName(c, 'Nurse');
  const grp = (n) => c.entityGroups.find((g) => g.name === n);
  assert.strictEqual(grp('Hospital').parentId, grp('Liminal Gate').id); assert.strictEqual(grp('Patient Room').parentId, grp('Hospital').id);
  assert.strictEqual(gate.groupId, grp('Liminal Gate').id); assert.strictEqual(hosp.groupId, grp('Liminal Gate').id);
  assert.strictEqual(room.groupId, grp('Hospital').id); assert.strictEqual(doc.groupId, grp('Hospital').id); assert.strictEqual(nurse.groupId, grp('Patient Room').id);
  const pres = (l) => c.blocks.find((b) => b.kind === 'arrival' && b.locationId === l.id).presence.sort();
  assert.deepStrictEqual(pres(gate), [hosp.id]);
  assert.deepStrictEqual(pres(hosp), [doc.id, room.id].sort());
  assert.deepStrictEqual(pres(room), [doc.id, nurse.id].sort());
  const topic = (e) => c.contentModules.find((m) => m.type === 'topic' && c.assignments.some((a) => a.moduleId === m.id && a.entityId === e.id));
  assert.ok(topic(doc).text.includes('Breathe in.') && topic(doc).text.includes('Breathe out.'));
  assert.ok(topic(nurse).text.includes('Alles wird gut'));
  const cp = c.checkpoints[0].id;
  const d = c.contentModules.find((m) => m.type === 'description' && c.assignments.some((a) => a.moduleId === m.id && a.entityId === hosp.id && a.timeId === cp));
  assert.ok(d.html.includes('[[' + doc.id + ']]') && d.html.includes('[[' + room.id + ']]'));
  assert.strictEqual(run(c, nested).plan.counts.new || 0, 0);
});

test('toggle lists: topic:t_* become dialogue topics, beat:t_* become sections; sent back under the same key', () => {
  const nested = require('./fixtures/kodex-sample-nested.json');
  const c = fresh(); run(c, nested);
  const doc = byName(c, 'Doctor'), hosp = byName(c, 'Hospital'), cp = c.checkpoints[0].id;
  const mods = (e, t) => c.assignments.filter((a) => a.entityId === e.id).map((a) => c.contentModules.find((m) => m.id === a.moduleId)).filter((m) => m && m.type === t);
  const topics = mods(doc, 'topic').map((m) => m.name).sort();
  assert.deepStrictEqual(topics, ['Ask about the Gate', 'Ask about the night shift', 'Dialog']);
  const night = mods(doc, 'topic').find((m) => m.name === 'Ask about the night shift');
  assert.ok(night.text.startsWith('He sighs.') && night.text.includes('- "Never ask."'));
  assert.ok(!mods(doc, 'topic').find((m) => m.name === 'Dialog').text.includes('sighs'));
  const basement = mods(hosp, 'beat').find((m) => m.name === 'The basement');
  assert.ok(basement && basement.text.includes('Scratching at night'));
  assert.ok(c.assignments.some((a) => a.moduleId === basement.id && a.timeId === cp));
  night.text += '\nAnd more.';
  const { pkg } = KS.buildKuratorExport(c, {});
  const t = pkg.entities.find((e) => e.name === 'Doctor').targets['topic:t_ask-about-the-night-shift'];
  assert.strictEqual(t.base, 'a1629e46486ad76b3d50fc781b6201cc0200d643'); assert.strictEqual(t.title, 'Ask about the night shift');
  assert.ok(t.markdown.endsWith('And more.'));
});

test('line breaks survive both ways (single newline, hard break, blank line)', () => {
  const m = KS.mdToMarkup('line one  \nline two\n\nnew paragraph');
  assert.strictEqual(m, 'line one\nline two\n\nnew paragraph');
  assert.strictEqual(KS.markupToMd(m), 'line one\nline two\n\nnew paragraph');
});

test('read-only Kodex fields (race) are not sent back', () => {
  const c = fresh(); run(c, sample);
  byName(c, 'Grey man').profile.race = 'Changed in Kurator';
  const e = KS.buildKuratorExport(c, {}).pkg.entities[0];
  assert.ok(!e || !e.targets['profile.race']);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }

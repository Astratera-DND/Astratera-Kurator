const assert = require('assert');
const DM = require('../src/dataModel');
const Q = require('../src/quests');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }

function setup() {
  const c = DM.emptyCampaign();
  const q = DM.createEntity(c, { type: 'quest', name: 'Find the key' });
  const q2 = DM.createEntity(c, { type: 'quest', name: 'Other' });
  const mods = ['note', 'topic', 'scene', 'description'].map((t) => DM.createContentModule(c, { type: t, name: t }));
  return { c, q, q2, mods };
}
const order = (c, q) => Q.itemsOf(c, q.id).map((m) => m.name);

test('a quest is an entity with its own id and icon', () => {
  const { q } = setup();
  assert.strictEqual(q.type, 'quest'); assert.ok(q.id.startsWith('quest_')); assert.strictEqual(q.icon, 'flag');
});
test('new tagged content goes on top with the next index, any content type', () => {
  const { c, q, mods } = setup();
  mods.forEach((m, i) => assert.strictEqual(Q.assign(c, m.id, q.id), i + 1));
  assert.deepStrictEqual(order(c, q), ['note', 'topic', 'scene', 'description']);
});
test('re-tagging the same quest changes nothing; switching quest renumbers both', () => {
  const { c, q, q2, mods } = setup();
  mods.forEach((m) => Q.assign(c, m.id, q.id));
  Q.assign(c, mods[1].id, q.id);
  assert.strictEqual(mods[1].questIndex, 2);
  Q.assign(c, mods[1].id, q2.id);
  assert.deepStrictEqual(order(c, q), ['note', 'scene', 'description']);
  assert.deepStrictEqual(Q.itemsOf(c, q.id).map((m) => m.questIndex), [1, 2, 3]);
  assert.strictEqual(mods[1].questId, q2.id); assert.strictEqual(mods[1].questIndex, 1);
});
test('moving to an index, stepping and drag-and-drop all keep 1..n', () => {
  const { c, q, mods } = setup();
  mods.forEach((m) => Q.assign(c, m.id, q.id));
  Q.moveTo(c, mods[3].id, 1);
  assert.deepStrictEqual(order(c, q), ['description', 'note', 'topic', 'scene']);
  Q.step(c, mods[3].id, 1);
  assert.deepStrictEqual(order(c, q), ['note', 'description', 'topic', 'scene']);
  Q.moveBefore(c, mods[0].id, null);
  assert.deepStrictEqual(order(c, q), ['description', 'topic', 'scene', 'note']);
  Q.moveBefore(c, mods[0].id, mods[2].id);
  assert.deepStrictEqual(order(c, q), ['description', 'topic', 'note', 'scene']);
  Q.moveTo(c, mods[0].id, 99);
  assert.deepStrictEqual(Q.itemsOf(c, q.id).map((m) => m.questIndex), [1, 2, 3, 4]);
  assert.strictEqual(Q.itemsOf(c, q.id)[3].name, 'note');
});
test('removing a block or a whole quest closes the gap / frees the blocks', () => {
  const { c, q, mods } = setup();
  mods.forEach((m) => Q.assign(c, m.id, q.id));
  Q.unassign(c, mods[1].id);
  assert.deepStrictEqual(Q.itemsOf(c, q.id).map((m) => m.questIndex), [1, 2, 3]);
  assert.ok(!('questId' in mods[1]));
  Q.releaseQuest(c, q.id);
  assert.ok(mods.every((m) => !m.questId && !('questIndex' in m)));
});
test('sanitize drops tags of missing quests and renumbers', () => {
  const { c, q, mods } = setup();
  Q.assign(c, mods[0].id, q.id); Q.assign(c, mods[1].id, q.id);
  mods[2].questId = 'quest_gone'; mods[2].questIndex = 5;
  mods[0].questIndex = 7;
  Q.sanitize(c);
  assert.ok(!mods[2].questId);
  assert.deepStrictEqual(Q.itemsOf(c, q.id).map((m) => m.questIndex), [1, 2]);
});
test('quests never show up in entity pickers (presence, mentions) unless asked for', () => {
  const { c } = setup();
  const Query = require('../src/query');
  DM.createEntity(c, { type: 'npc', name: 'Grey' });
  const list = Query.filterEntitiesForPicker(c, Object.values(c.entities), {});
  assert.ok(list.every((e) => e.type !== 'quest') && list.length === 1);
  assert.strictEqual(Query.filterEntitiesForPicker(c, Object.values(c.entities), { type: 'quest' }).length, 2);
});

function exportSetup() {
  const c = DM.emptyCampaign();
  const q = DM.createEntity(c, { type: 'quest', name: 'Night of the Long Lights', summary: 'Help make the **candles**.' });
  const loc = DM.createEntity(c, { type: 'location', name: 'Patch' });
  const npc = DM.createEntity(c, { type: 'npc', name: 'Olda Renn' });
  const secret = DM.createEntity(c, { type: 'npc', name: 'Vladi' });
  const note = DM.createContentModule(c, { type: 'note', name: 'Candles at Vladi', text: `A candle should be with [[${secret.id}]]. DM: he lies.` });
  const arr = DM.createContentModule(c, { type: 'description', name: '', html: '<p>Fog rolls over the docks. Nobody is out.</p>' });
  DM.createAssignment(c, { moduleId: note.id, entityId: npc.id });
  DM.createAssignment(c, { moduleId: arr.id, entityId: loc.id });
  Q.assign(c, arr.id, q.id); Q.assign(c, note.id, q.id);
  return { c, q, note, arr, loc, npc, secret };
}
test('export: name, summary, and per step objective / clue / npcs / location, in quest order', () => {
  const { c, q, note, arr } = exportSetup();
  const e = Q.exportQuest(c, q.id);
  assert.strictEqual(e.name, 'Night of the Long Lights'); assert.strictEqual(e.summary, 'Help make the candles.');
  assert.deepStrictEqual(e.steps.map((s) => s.index), [1, 2]);
  assert.strictEqual(e.steps[0].id, arr.id);
  assert.strictEqual(e.steps[0].objective, 'Fog rolls over the docks.'); assert.strictEqual(e.steps[0].location, 'Patch');
  assert.strictEqual(e.steps[1].objective, 'Candles at Vladi');
  assert.deepStrictEqual(e.steps[1].npcs, ['Olda Renn', 'Vladi']);
  assert.ok(e.steps[1].clue.startsWith('A candle should be with Vladi.'));
});
test('export: overrides replace derived text, hidden steps are left out and renumbered, retagging clears them', () => {
  const { c, q, note, arr, q: quest } = exportSetup();
  Q.setPublic(c, note.id, { objective: 'Visit Vladi', clue: 'Vladi has a candle.' });
  Q.setPublic(c, arr.id, { hidden: true });
  const e = Q.exportQuest(c, q.id);
  assert.strictEqual(e.steps.length, 1); assert.strictEqual(e.steps[0].index, 1);
  assert.strictEqual(e.steps[0].objective, 'Visit Vladi'); assert.strictEqual(e.steps[0].clue, 'Vladi has a candle.');
  Q.setPublic(c, note.id, { objective: '' });
  assert.strictEqual(Q.exportQuest(c, q.id).steps[0].objective, 'Candles at Vladi');
  Q.unassign(c, note.id); assert.ok(!('questPublic' in note));
});
test('export: file envelope, all quests by default, JSON-safe', () => {
  const { c, q } = exportSetup();
  DM.createEntity(c, { type: 'quest', name: 'Empty' });
  const f = Q.exportQuests(c);
  assert.strictEqual(f.format, 'kurator-quests'); assert.strictEqual(f.version, 1); assert.strictEqual(f.quests.length, 2);
  assert.strictEqual(Q.exportQuests(c, [q.id]).quests.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f)).quests[0].steps.length >= 0, true);
});

const Cond = require('../src/conditions');
function rewardSetup() {
  const c = DM.emptyCampaign();
  const q = DM.createEntity(c, { type: 'quest', name: 'Candles' });
  const a = Q.addReward(q, 'A purse'); a.publish = true;
  const b = Q.addReward(q, 'a favour'); Q.updateReward(q, b.id, { joiner: 'or', publish: true });
  const secret = Q.addReward(q, 'secret stash');
  return { c, q, a, b, secret };
}
test('rewards: add / edit / order / remove, joiner only and|or', () => {
  const { q, a, b, secret } = rewardSetup();
  assert.deepStrictEqual(Q.rewardsOf(q).map((r) => r.text), ['A purse', 'a favour', 'secret stash']);
  Q.updateReward(q, b.id, { joiner: 'nonsense' }); assert.strictEqual(b.joiner, 'and');
  Q.moveReward(q, secret.id, -1); assert.strictEqual(Q.rewardsOf(q)[1].id, secret.id);
  Q.removeReward(q, secret.id); assert.strictEqual(Q.rewardsOf(q).length, 2);
});
test('rewards: only rewards flagged for the website are exported, joiner relative to the exported ones', () => {
  const { c, q, a, b } = rewardSetup();
  let e = Q.exportQuest(c, q.id);
  assert.deepStrictEqual(e.rewards.map((r) => [r.text, r.joiner]), [['A purse', null], ['a favour', 'or']]);
  Q.updateReward(q, b.id, { joiner: 'or' }); Q.updateReward(q, a.id, { publish: false });
  e = Q.exportQuest(c, q.id);
  assert.deepStrictEqual(e.rewards.map((r) => [r.text, r.joiner]), [['a favour', null]]);
});
test('rewards: a reward tied to a DC check unlocks only on the right result; missing check = open', () => {
  const { c, q, a } = rewardSetup();
  const chk = DM.createDCCheck(c, { name: 'Open the vault', checkType: 'athletics' });
  Cond.syncDCChecks(c);
  Q.updateReward(q, a.id, { dcCheckId: chk.id, dcWhen: 'pass' });
  assert.strictEqual(Q.rewardUnlocked(c, a, {}), false);                 // not rolled yet
  const dc = Cond.dcPassDC ? Cond.dcPassDC(chk) : 10;
  Cond.applyDCRoll(c, chk, 1);
  assert.strictEqual(Q.rewardUnlocked(c, a, {}), false);                 // low roll
  Cond.applyDCRoll(c, chk, 30);
  assert.strictEqual(Q.rewardUnlocked(c, a, {}), true);                  // high roll
  Q.updateReward(q, a.id, { dcWhen: 'fail' });
  assert.strictEqual(Q.rewardUnlocked(c, a, {}), false);
  c.dcChecks = [];
  assert.strictEqual(Q.rewardUnlocked(c, a, {}), true);                  // check deleted -> unlinked
});
test('rewards: sanitize repairs the list; a quest without rewards gets []', () => {
  const c = DM.emptyCampaign();
  const q = DM.createEntity(c, { type: 'quest', name: 'X' });
  q.rewards = [null, { text: 5, joiner: 'x', dcWhen: 'bogus' }];
  Q.sanitize(c);
  assert.strictEqual(q.rewards.length, 1); assert.strictEqual(q.rewards[0].text, '5');
  assert.strictEqual(q.rewards[0].joiner, 'and'); assert.strictEqual(q.rewards[0].dcWhen, 'pass'); assert.ok(q.rewards[0].id);
});
test('rewards: the [[REWARD:id]] marker renders the list in Play (check first when locked), a plain marker while editing', () => {
  const Query = require('../src/query');
  const { c, q, a } = rewardSetup();
  const chk = DM.createDCCheck(c, { name: 'Vault', checkType: 'athletics' }); Cond.syncDCChecks(c);
  Q.updateReward(q, a.id, { dcCheckId: chk.id });
  const tok = `Done. [[REWARD:${q.id}]]`;
  Cond.setContext({ mode: 'play' });
  let html = Query.renderMentions(tok, c).html;
  assert.ok(html.includes('data-reward="' + q.id + '"')); assert.ok(html.includes('dc-check-btn')); assert.ok(!html.includes('A purse'));
  assert.ok(html.includes('a favour') && html.includes('reward-join'));
  Cond.applyDCRoll(c, chk, 30);
  html = Query.renderMentions(tok, c).html;
  assert.ok(html.includes('A purse') && !html.includes('dc-check-btn'));
  Cond.setContext({ mode: 'edit' });
  html = Query.renderMentions(tok, c).html;
  assert.ok(html.includes('Reward (3)') && !html.includes('A purse'));
  Cond.setContext({ mode: 'play' });
});
test('rewards: marker in a step clue turns into the published rewards in the export', () => {
  const { c, q } = rewardSetup();
  const m = DM.createContentModule(c, { type: 'note', name: 'End', text: `You get [[REWARD:${q.id}]]` });
  Q.assign(c, m.id, q.id);
  assert.strictEqual(Q.exportQuest(c, q.id).steps[0].clue, 'You get A purse or a favour');
});

require('./kodexSync.test');
require('./kodexBridge.test');
require('./encounters.test');
require('./dcchecks.test');
require('./dialogAssignee.test');
if (failures) { console.log(`${failures} failed`); process.exit(1); }

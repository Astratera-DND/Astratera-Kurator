// Quests: a tag any content block can carry. A quest is an entity of type 'quest'
// (so it lives in the Entities list); a content block that belongs to it stores
//   module.questId     the quest entity's id
//   module.questIndex  its place inside the quest: 1, 2, 3 …
// Tagging a block puts it on top (highest index). Moving a block, or removing
// it, always renumbers the rest to 1..n with no gaps. Nothing else is stored:
// the quest lane in the graph and the quest page are derived from these two fields.
(function () {

// Quests are yellow, with a little hue variety towards orange (picked from the quest's id, so it is stable).
const QUEST_COLORS = ['yellow', 'gold', 'amber', 'honey', 'orange'];
function questColorKey(id) { let h = 0; String(id || '').split('').forEach((ch) => { h = (h * 31 + ch.charCodeAt(0)) >>> 0; }); return QUEST_COLORS[h % QUEST_COLORS.length]; }

function isQuest(e) { return !!e && e.type === 'quest'; }
function questList(campaign) { return Object.values(campaign.entities || {}).filter(isQuest).sort((a, b) => a.name.localeCompare(b.name)); }
function moduleById(campaign, id) { return (campaign.contentModules || []).find((m) => m.id === id) || null; }

// Blocks of a quest, lowest index first (ties keep list order; unnumbered go last).
function itemsOf(campaign, questId) {
  return (campaign.contentModules || [])
    .map((m, i) => ({ m, i }))
    .filter((x) => x.m.questId === questId)
    .sort((a, b) => ((a.m.questIndex || 1e9) - (b.m.questIndex || 1e9)) || (a.i - b.i))
    .map((x) => x.m);
}

function renumber(campaign, questId) {
  itemsOf(campaign, questId).forEach((m, i) => { m.questIndex = i + 1; });
}

// Tag a block as part of a quest. It goes on top (highest index). Re-tagging with the same quest changes nothing.
function assign(campaign, moduleId, questId) {
  const m = moduleById(campaign, moduleId);
  const q = campaign.entities && campaign.entities[questId];
  if (!m || !isQuest(q)) return null;
  if (m.questId === questId && m.questIndex) return m.questIndex;
  const old = m.questId;
  delete m.questId; delete m.questIndex; delete m.questPublic;
  if (old) renumber(campaign, old);
  m.questId = questId;
  m.questIndex = itemsOf(campaign, questId).filter((x) => x.id !== m.id).length + 1;
  renumber(campaign, questId);
  return m.questIndex;
}

function unassign(campaign, moduleId) {
  const m = moduleById(campaign, moduleId);
  if (!m || !m.questId) return;
  const old = m.questId;
  delete m.questId; delete m.questIndex; delete m.questPublic;
  renumber(campaign, old);
}

// Put a block at position `index` (1-based, clamped) inside its quest.
function moveTo(campaign, moduleId, index) {
  const m = moduleById(campaign, moduleId);
  if (!m || !m.questId) return;
  const items = itemsOf(campaign, m.questId).filter((x) => x.id !== m.id);
  const at = Math.max(0, Math.min(items.length, Math.round(Number(index) || 1) - 1));
  items.splice(at, 0, m);
  items.forEach((x, i) => { x.questIndex = i + 1; });
}

function step(campaign, moduleId, delta) {
  const m = moduleById(campaign, moduleId);
  if (m && m.questId) moveTo(campaign, moduleId, (m.questIndex || 1) + delta);
}

// Drag and drop: place `moduleId` before `beforeId` (null = last).
function moveBefore(campaign, moduleId, beforeId) {
  const m = moduleById(campaign, moduleId);
  if (!m || !m.questId) return;
  const items = itemsOf(campaign, m.questId).filter((x) => x.id !== m.id);
  const at = beforeId ? items.findIndex((x) => x.id === beforeId) : -1;
  items.splice(at < 0 ? items.length : at, 0, m);
  items.forEach((x, i) => { x.questIndex = i + 1; });
}

// Repairs: tags pointing at a missing quest are dropped; every quest is numbered 1..n.
function sanitize(campaign) {
  // Quests made before they had their own colour get one once; a colour chosen afterwards is kept.
  Object.values(campaign.entities || {}).forEach((e) => { if (isQuest(e) && !e.questColorSet) { e.color = questColorKey(e.id); e.questColorSet = true; } });
  Object.values(campaign.entities || {}).forEach((e) => {
    if (!isQuest(e)) return;
    if (!Array.isArray(e.rewards)) { e.rewards = []; return; }
    e.rewards = e.rewards.filter((r) => r && typeof r === 'object').map((r) => ({ id: r.id || newRewardId(), text: String(r.text || ''), joiner: r.joiner === 'or' ? 'or' : 'and', dcCheckId: r.dcCheckId || null, dcWhen: DC_WHEN[r.dcWhen] ? r.dcWhen : 'pass', publish: !!r.publish }));
  });
  (campaign.contentModules || []).forEach((m) => {
    if (m.questId && !isQuest((campaign.entities || {})[m.questId])) { delete m.questId; delete m.questIndex; delete m.questPublic; }
    else if (!m.questId && 'questIndex' in m) delete m.questIndex;
    else if (m.questId && !Number.isFinite(Number(m.questIndex))) m.questIndex = 0;
  });
  const ids = new Set((campaign.contentModules || []).filter((m) => m.questId).map((m) => m.questId));
  ids.forEach((id) => renumber(campaign, id));
}

// When a quest entity is deleted its blocks lose the tag (they stay otherwise untouched).
function releaseQuest(campaign, questId) {
  (campaign.contentModules || []).forEach((m) => { if (m.questId === questId) { delete m.questId; delete m.questIndex; delete m.questPublic; } });
}


// --- Rewards ---------------------------------------------------------------------------------
// A quest entity can hold rewards: quest.rewards = [{ id, text, joiner, dcCheckId, dcWhen, publish }].
//   joiner     how this reward relates to the one before it: 'and' | 'or' (ignored for the first)
//   dcCheckId  optional: the reward only becomes visible in Play once that DC check has the result in dcWhen;
//              until then Play shows the check itself. A deleted check simply unlinks the reward.
//   dcWhen     'pass' (success or critical success) | 'crit' (critical success) | 'fail' (failure or critical failure)
//   publish    only rewards flagged here go into the website export (the DM says which ones players know about)
// A [[REWARD:questId]] token in any text shows this whole list in Play.
const DC_WHEN = { pass: ['success', 'critSuccess'], crit: ['critSuccess'], fail: ['fail', 'critFail'] };
const DC_WHEN_LABELS = { pass: 'is passed', crit: 'is a critical success', fail: 'is failed' };

function newRewardId() { return `rwd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
function rewardsOf(quest) { return quest && Array.isArray(quest.rewards) ? quest.rewards : []; }

function addReward(quest, text) {
  if (!isQuest(quest)) return null;
  if (!Array.isArray(quest.rewards)) quest.rewards = [];
  const r = { id: newRewardId(), text: String(text || ''), joiner: 'and', dcCheckId: null, dcWhen: 'pass', publish: false };
  quest.rewards.push(r);
  return r;
}
function updateReward(quest, rewardId, patch) {
  const r = rewardsOf(quest).find((x) => x.id === rewardId);
  if (!r) return null;
  Object.assign(r, patch || {});
  if (r.joiner !== 'or') r.joiner = 'and';
  if (!DC_WHEN[r.dcWhen]) r.dcWhen = 'pass';
  if (!r.dcCheckId) r.dcCheckId = null;
  return r;
}
function removeReward(quest, rewardId) { if (quest && Array.isArray(quest.rewards)) quest.rewards = quest.rewards.filter((x) => x.id !== rewardId); }
function moveReward(quest, rewardId, delta) {
  const a = rewardsOf(quest); const i = a.findIndex((x) => x.id === rewardId); const j = i + delta;
  if (i < 0 || j < 0 || j >= a.length) return;
  const t = a[i]; a[i] = a[j]; a[j] = t;
}

// Has this reward's DC check been resolved the right way? Rewards without a (still existing) check are always open.
function rewardUnlocked(campaign, reward, ctx) {
  if (!reward || !reward.dcCheckId) return true;
  const check = (campaign.dcChecks || []).find((c) => c.id === reward.dcCheckId);
  if (!check) return true;
  const C = (typeof module !== 'undefined' && module.exports) ? require('./conditions') : window.Conditions;
  const cond = check.conditionId ? C.byId(campaign, check.conditionId) : null;
  if (!cond) return false;
  const state = C.stateOf(campaign, cond, ctx || { curTimeId: null });
  return !!state && (DC_WHEN[reward.dcWhen] || DC_WHEN.pass).includes(state);
}

// The rewards as one line of plain text: "A and B or C". onlyPublished: just the ones flagged for the website.
function rewardsText(campaign, quest, onlyPublished) {
  const list = rewardsOf(quest).filter((r) => (!onlyPublished || r.publish) && String(r.text || '').trim());
  return list.map((r, i) => (i ? ` ${r.joiner === 'or' ? 'or' : 'and'} ` : '') + plain(campaign, r.text).replace(/\n+/g, ' ')).join('');
}
function publishedRewards(campaign, quest) {
  return rewardsOf(quest).filter((r) => r.publish && String(r.text || '').trim()).map((r, i) => ({ id: r.id, text: plain(campaign, r.text).replace(/\n+/g, ' '), joiner: i ? (r.joiner === 'or' ? 'or' : 'and') : null }));
}

// --- Export for the players' quest website ---------------------------------------------------
// A stripped-down, player-facing view of a quest: its name and, per step, an objective, a clue,
// the NPCs involved and the location. Nothing else (no DM notes structure, ids of DC checks, conditions…).
// The DM can override the objective / clue text per step or hide a step: module.questPublic = { objective, clue, hidden }.
const EXPORT_FORMAT = 'kurator-quests';
const EXPORT_VERSION = 1;

function plain(campaign, s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/\[\[DCCHECK:([a-zA-Z0-9_]+)\]\]/g, (m, id) => { const c = (campaign.dcChecks || []).find((x) => x.id === id); return c && c.name ? c.name : ''; })
    .replace(/\[\[REWARD:([a-zA-Z0-9_]+)\]\]/g, (m, id) => { const q = (campaign.entities || {})[id]; return q && isQuest(q) ? rewardsText(campaign, q, true) : ''; })
    .replace(/\[\[(SCENEBTN|MUSICBTN|QFBTN|DIRBTN):[^\]]*\]\]/g, '').replace(/\[\[\/(SCENEBTN|MUSICBTN|QFBTN|DIRBTN)\]\]/g, '')
    .replace(/\[\[SAY:[a-zA-Z0-9_]+\]\]/g, '').replace(/\[\[\/SAY\]\]/g, '')
    .replace(/\[\[JUMP:[a-zA-Z0-9_:]+\]\]/g, '').replace(/\[\[\/JUMP\]\]/g, '')
    .replace(/\[\[\/?IF(:[^\]]*)?\]\]/g, '')
    .replace(/\[\[([a-zA-Z0-9_]+)\]\]/g, (m, id) => (campaign.entities[id] ? campaign.entities[id].name : ''))
    .replace(/(\*\*|\^\^|__|~~)/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

// Every entity id a block refers to, in order of appearance: where it is placed, scene speakers, mentions in its text.
function referencedIds(campaign, m) {
  const ids = [];
  (campaign.assignments || []).filter((a) => a.moduleId === m.id).forEach((a) => ids.push(a.entityId));
  const texts = m.type === 'scene' ? (m.lines || []).map((l) => { if (l.speakerId) ids.push(l.speakerId); return l.text; }) : [m.type === 'description' ? m.html : m.text];
  texts.forEach((t) => { String(t || '').replace(/\[\[(?:SAY:)?([a-zA-Z0-9_]+)\]\]/g, (x, id) => { ids.push(id); return x; }); });
  return ids.filter((id, i) => ids.indexOf(id) === i && campaign.entities[id]);
}

function stepText(campaign, m) {
  if (m.type === 'scene') {
    return (m.lines || []).map((l) => {
      const who = l.speakerId && campaign.entities[l.speakerId] ? campaign.entities[l.speakerId].name : '';
      const t = plain(campaign, l.text);
      return who && t ? `${who}: ${t}` : t;
    }).filter(Boolean).join('\n');
  }
  return plain(campaign, m.type === 'description' ? m.html : m.text);
}

function firstSentence(t) { const one = String(t || '').split('\n')[0]; const m = one.match(/^(.{8,160}?[.!?])(\s|$)/); return (m ? m[1] : one.slice(0, 120)).trim(); }

// What the export would contain for one step, before any override (used to prefill the editor too).
function derivedStep(campaign, m) {
  const ents = referencedIds(campaign, m).map((id) => campaign.entities[id]);
  const text = stepText(campaign, m);
  const name = plain(campaign, m.name);
  const loc = ents.find((e) => e.type === 'location');
  return {
    objective: name || firstSentence(text),
    clue: text,
    npcs: ents.filter((e) => e.type === 'npc').map((e) => e.name).filter(Boolean),
    location: loc ? loc.name : ''
  };
}

function exportQuest(campaign, questId) {
  const q = (campaign.entities || {})[questId];
  if (!isQuest(q)) return null;
  const steps = [];
  itemsOf(campaign, questId).forEach((m) => {
    const o = m.questPublic || {};
    if (o.hidden) return;
    const d = derivedStep(campaign, m);
    const objective = (o.objective != null && String(o.objective).trim()) ? String(o.objective).trim() : d.objective;
    const clue = (o.clue != null && String(o.clue).trim()) ? String(o.clue).trim() : d.clue;
    steps.push({ id: m.id, index: steps.length + 1, objective, clue, npcs: d.npcs, location: d.location });
  });
  return { id: q.id, name: q.name || '', summary: plain(campaign, q.summary), rewards: publishedRewards(campaign, q), steps };
}

function exportQuests(campaign, questIds) {
  const ids = questIds && questIds.length ? questIds : questList(campaign).map((q) => q.id);
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), quests: ids.map((id) => exportQuest(campaign, id)).filter(Boolean) };
}

function setPublic(campaign, moduleId, patch) {
  const m = moduleById(campaign, moduleId);
  if (!m || !m.questId) return;
  const cur = Object.assign({}, m.questPublic || {}, patch);
  Object.keys(cur).forEach((k) => { if (cur[k] === '' || cur[k] === false || cur[k] == null) delete cur[k]; });
  if (Object.keys(cur).length) m.questPublic = cur; else delete m.questPublic;
}

const api = { DC_WHEN, DC_WHEN_LABELS, rewardsOf, addReward, updateReward, removeReward, moveReward, rewardUnlocked, rewardsText, publishedRewards, exportQuest, exportQuests, derivedStep, setPublic, EXPORT_FORMAT, EXPORT_VERSION, QUEST_COLORS, questColorKey, isQuest, questList, itemsOf, assign, unassign, moveTo, step, moveBefore, sanitize, releaseQuest, renumber };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.Quests = api;
})();

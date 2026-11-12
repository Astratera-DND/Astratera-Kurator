// Travel encounters: an encounter is a place-like entity flagged `encounter: true`. It has all the
// normal content (description, sections, notes, scenes, present here) but no checkpoints of its own,
// so all its content sits on one hidden "encounter" checkpoint. Encounters never show up in normal
// Play/Create lists; they live in the Encounters tab and in the wagon mode.
//
// A collection is an ordered table of encounters with a die: campaign.encounterCollections =
//   [{ id, name, route: { from, via[], to, note } | null, entries: [{ encounterId|null, kodexId?, name? }], external? }]
// The die and the ranges are derived from the number of entries (the same rule Kodex uses).
(function () {

const RESERVED_CP_ID = 'cp_encounter';
const DICE = [4, 6, 8, 10, 12, 20, 100];
let scope = 'campaign';

function getScope() { return scope; }
function setScope(s) { scope = s === 'encounter' ? 'encounter' : 'campaign'; }
function isEncounter(e) { return !!e && e.type === 'location' && e.encounter === true; }
// Is this entity part of the list the person is looking at right now?
function inScope(e) { return !!e && (scope === 'encounter' ? isEncounter(e) : !isEncounter(e)); }
function isEncounterCp(cp) { return !!cp && cp.encounter === true; }

function ensureCheckpoint(campaign) {
  let cp = (campaign.checkpoints || []).find(isEncounterCp);
  if (!cp) { cp = { id: RESERVED_CP_ID, label: 'Encounter', order: -1, encounter: true }; campaign.checkpoints.push(cp); }
  return cp.id;
}

// --- the die ---------------------------------------------------------------------------------
function diceFor(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n === 0) return { die: 0, label: '', kind: 'none', note: '', ranges: [] };
  if (n === 1) return { die: 0, label: '', kind: 'none', note: 'A single encounter – no roll needed', ranges: [{ from: 1, to: 1 }] };
  if (DICE.includes(n)) return { die: n, label: `d${n}`, kind: 'exact', note: '', ranges: Array.from({ length: n }, (_, i) => ({ from: i + 1, to: i + 1 })) };
  const group = DICE.find((d) => d > n && d % n === 0);
  if (group) {
    const w = group / n;
    return { die: group, label: `d${group}`, kind: 'group', note: '', ranges: Array.from({ length: n }, (_, i) => ({ from: i * w + 1, to: (i + 1) * w })) };
  }
  const die = DICE.find((d) => d > n) || 100;
  const note = n > 100 ? 'More than 100 encounters: split the collection' : (die === n + 1 ? `Reroll ${die}` : `Reroll ${n + 1}–${die}`);
  return { die, label: `d${die}`, kind: 'reroll', note, ranges: Array.from({ length: Math.min(n, die) }, (_, i) => ({ from: i + 1, to: i + 1 })) };
}

function rollDie(die, rng) { return 1 + Math.floor((rng || Math.random)() * die); }

// One roll on a table (see tableOf). Returns { roll, row } where row is null when the roll falls in a
// "roll again" gap, or { roll: null, row } when there is nothing to roll.
function rollOn(table, rng) {
  if (!table.rows.length) return { roll: null, row: null };
  if (!table.dice.die) return { roll: null, row: table.rows[0] };
  const roll = rollDie(table.dice.die, rng);
  return { roll, row: table.rows.find((r) => roll >= r.from && roll <= r.to) || null };
}

// --- collections -------------------------------------------------------------------------------
function list(campaign) { if (!Array.isArray(campaign.encounterCollections)) campaign.encounterCollections = []; return campaign.encounterCollections; }
function collectionById(campaign, id) { return list(campaign).find((c) => c.id === id) || null; }
function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`; }

function createCollection(campaign, { name = 'New collection' } = {}) {
  const col = { id: makeId('col'), name, route: null, entries: [], createdAt: new Date().toISOString() };
  list(campaign).push(col);
  return col;
}
function deleteCollection(campaign, id) { campaign.encounterCollections = list(campaign).filter((c) => c.id !== id); }
function addEntry(campaign, colId, encounterId, at) {
  const col = collectionById(campaign, colId);
  if (!col || !campaign.entities[encounterId]) return false;
  const entry = { encounterId };
  if (at === undefined || at === null || at >= col.entries.length) col.entries.push(entry); else col.entries.splice(Math.max(0, at), 0, entry);
  return true;
}
function removeEntry(campaign, colId, index) {
  const col = collectionById(campaign, colId);
  if (!col || index < 0 || index >= col.entries.length) return false;
  col.entries.splice(index, 1);
  return true;
}
function moveEntry(campaign, colId, index, direction) {
  const col = collectionById(campaign, colId);
  const to = index + direction;
  if (!col || index < 0 || to < 0 || index >= col.entries.length || to >= col.entries.length) return false;
  const [e] = col.entries.splice(index, 1); col.entries.splice(to, 0, e);
  return true;
}

// The table a collection shows and rolls on: [{ index, from, to, range, encounterId, name, missing }]
function tableOf(campaign, col) {
  const dice = diceFor(col.entries.length);
  const rows = col.entries.map((en, i) => {
    const ent = en.encounterId ? campaign.entities[en.encounterId] : null;
    const r = dice.ranges[i] || { from: i + 1, to: i + 1 };
    return {
      index: i + 1, from: r.from, to: r.to, range: r.from === r.to ? String(r.from) : `${r.from}–${r.to}`,
      encounterId: ent ? ent.id : null, name: ent ? ent.name : (en.missing ? 'Deleted in Kodex' : (en.name || 'Not imported yet')), missing: !ent
    };
  });
  return { dice, rows };
}

// Collections an encounter is part of.
function collectionsOf(campaign, encounterId) { return list(campaign).filter((c) => c.entries.some((e) => e.encounterId === encounterId)); }

function routeText(route) {
  if (!route) return '';
  const stops = [route.from && route.from.name, ...((route.via || []).map((v) => v && v.name)), route.to && route.to.name].filter(Boolean);
  const t = stops.join(' → ');
  return route.note ? (t ? `${t} · ${route.note}` : route.note) : t;
}

// Entries that were waiting for an encounter to be imported: link them once it exists.
function relinkEntries(campaign, kodexIdOf) {
  list(campaign).forEach((col) => col.entries.forEach((en) => {
    if (en.encounterId && campaign.entities[en.encounterId]) return;
    if (!en.kodexId) return;
    const hit = Object.values(campaign.entities).find((e) => kodexIdOf(e) === en.kodexId);
    if (hit) en.encounterId = hit.id;
  }));
}

function sanitize(campaign) {
  if (!Array.isArray(campaign.encounterCollections)) return;     // never add the key to a campaign that has none
  const cols = campaign.encounterCollections;
  cols.forEach((c) => {
    if (!c.id) c.id = makeId('col');
    if (typeof c.name !== 'string') c.name = 'Collection';
    if (!Array.isArray(c.entries)) c.entries = [];
    c.entries = c.entries.filter((e) => e && typeof e === 'object');
    if (c.route && typeof c.route !== 'object') c.route = null;
  });
}

const api = {
  RESERVED_CP_ID, getScope, setScope, isEncounter, inScope, isEncounterCp, ensureCheckpoint,
  diceFor, rollDie, rollOn, list, collectionById, createCollection, deleteCollection, addEntry, removeEntry, moveEntry,
  tableOf, collectionsOf, routeText, relinkEntries, sanitize
};
if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.Encounters = api;

})();

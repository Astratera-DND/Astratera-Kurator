// Travel encounters in the renderer: scope switching, the wagon mode in Play, and the collection builder in Create.
//
// An encounter is a place-like entity (see src/encounters.js). Everything that lists entities looks at the
// current *scope*: 'campaign' (the normal lists, encounters hidden) or 'encounter' (only encounters).
// Each scope keeps its own copy of the place the person was at (current place/time, open cards, the Create
// tab and selection, ...), so the wagon always brings you back to exactly where you were.

const ENC_SCOPE_KEYS = ['curLocation', 'curTime', 'openEntityIds', 'fullPageEntityId', 'createTab', 'createSelectedEntityId',
  'createContentLocationId', 'createContentTimeId', 'expandedIds', 'entitySearchQuery', 'locSearch', 'newEntityDraft'];

function isEncScope() { return window.Encounters.getScope() === 'encounter'; }
function notEnc(e) { return !window.Encounters.isEncounter(e); }

function encDesiredScope() {
  if (ui.mode === 'play') return ui.encMode ? 'encounter' : 'campaign';
  return ui.createScope === 'encounter' ? 'encounter' : 'campaign';
}

// Swap the per-scope parts of `ui` when the scope changes. Called at the start of every renderAll.
function syncScope() {
  const want = encDesiredScope();
  const have = ui.scopeApplied || 'campaign';
  if (want !== have) {
    ui.scopeSaved = ui.scopeSaved || {};
    const snap = {};
    ENC_SCOPE_KEYS.forEach((k) => { snap[k] = ui[k]; });
    ui.scopeSaved[have] = snap;
    const next = ui.scopeSaved[want];
    if (next) {
      ENC_SCOPE_KEYS.forEach((k) => { ui[k] = next[k]; });
    } else if (want === 'encounter') {
      Object.assign(ui, { curLocation: null, openEntityIds: [], fullPageEntityId: null, createTab: 'entities', createSelectedEntityId: null,
        createContentLocationId: null, expandedIds: [], entitySearchQuery: '', locSearch: '', newEntityDraft: null });
    }
    ui.scopeApplied = want;
  }
  window.Encounters.setScope(want);
  if (want === 'encounter') {
    const id = window.Encounters.ensureCheckpoint(campaign);
    ui.curTime = id; ui.createContentTimeId = id;
  }
}

function encResetForCampaign() {
  ui.encMode = false; ui.createScope = 'campaign'; ui.scopeApplied = 'campaign'; ui.scopeSaved = {};
  ui.encRun = { collectionId: null, started: false, roll: null, rowIndex: null, used: [], log: [] };
  ui.encSelectedCollectionId = null; ui.encDeleteArm = null;
  window.Encounters.setScope('campaign');
}

function encRun() {
  if (!ui.encRun) ui.encRun = { collectionId: null, started: false, roll: null, rowIndex: null, used: [], log: [] };
  return ui.encRun;
}

// Leaving the wagon because a link led to a normal place or NPC page.
function leaveEncounterFor(entityId) {
  const e = campaign.entities[entityId];
  if (ui.mode === 'play' && isEncScope() && e && !window.Encounters.isEncounter(e)) { ui.encMode = false; syncScope(); }
}

function encCollectionName(c) { return c.name && c.name.trim() ? c.name : 'Untitled collection'; }

// --- Play: the wagon panel -----------------------------------------------------------------------

function encPanelHTML() {
  const E = window.Encounters;
  const run = encRun();
  const cols = E.list(campaign);
  let html = `<div class="enc-panel">`;
  html += `<div class="enc-head">${icon('wagon')} <b>Travel encounters</b> <span class="hint">Click the wagon again to return to the campaign.</span></div>`;
  if (!cols.length) {
    return html + `<p class="empty-hint">No collections yet. Build one under Create → Encounters → Collections, or import one from Kodex.</p></div>`;
  }
  if (!run.collectionId || !E.collectionById(campaign, run.collectionId)) run.collectionId = cols[0].id;
  const col = E.collectionById(campaign, run.collectionId);
  const table = E.tableOf(campaign, col);
  html += `<div class="inline enc-pick">
    <select onchange="window.app.encPickCollection(this.value)">${cols.map((c) => `<option value="${c.id}" ${c.id === col.id ? 'selected' : ''}>${esc(encCollectionName(c))} (${c.entries.length})</option>`).join('')}</select>
    <button class="icon-btn primary" onclick="window.app.encStart()" ${col.entries.length ? '' : 'disabled'}>${icon('arrowRight')} ${run.started ? 'Restart journey' : 'Start'}</button>
  </div>`;
  const rt = E.routeText(col.route);
  if (rt) html += `<div class="enc-route">${icon('mapPin')} ${esc(rt)}</div>`;
  if (!col.entries.length) return html + `<p class="empty-hint">This collection has no encounters yet.</p></div>`;

  if (run.started) {
    const d = table.dice;
    let result = '';
    if (d.die) {
      if (run.roll == null) result = `<span class="enc-roll-hint">Roll ${esc(d.label)}</span>`;
      else if (run.rowIndex == null) result = `<span class="enc-roll"><b>${run.roll}</b> on ${esc(d.label)}</span> <span class="enc-again">No encounter on ${run.roll} – roll again</span>`;
      else result = `<span class="enc-roll"><b>${run.roll}</b> on ${esc(d.label)}</span> → <b>${esc(table.rows[run.rowIndex].name)}</b>`;
    } else if (run.rowIndex != null) result = `<b>${esc(table.rows[run.rowIndex].name)}</b>`;
    html += `<div class="enc-rollbar">
      ${d.die ? `<button class="icon-btn" onclick="window.app.encRoll()">${icon('dice')} Roll ${esc(d.label)}</button>` : ''}
      <span class="enc-result">${result}</span>
      <button class="mini-btn" title="End the journey" onclick="window.app.encEnd()">${icon('x')}</button>
    </div>`;
    if (d.note && d.kind === 'reroll') html += `<div class="hint">${esc(d.note)}</div>`;
  } else {
    html += `<p class="hint">${table.dice.die ? `Start rolls a ${esc(table.dice.label)}. You can still open any encounter by hand.` : 'A single encounter: nothing to roll.'}</p>`;
  }

  html += `<div class="enc-table">` + table.rows.map((r, i) => {
    const used = r.encounterId && run.used.includes(r.encounterId);
    const hit = run.started && run.rowIndex === i;
    return `<button class="enc-row ${hit ? 'hit' : ''} ${used ? 'used' : ''} ${r.encounterId ? '' : 'missing'}" ${r.encounterId ? `onclick="window.app.encOpen('${r.encounterId}')"` : 'disabled'}>
      <span class="enc-range">${esc(r.range)}</span>
      <span class="enc-name">${esc(r.name)}</span>
      ${used ? `<span class="enc-used">${icon('check')} used</span>` : ''}
    </button>`;
  }).join('') + `</div>`;
  if (run.log.length) html += `<div class="enc-log"><span class="hint">Journey:</span> ${run.log.map((l) => esc(l)).join(' → ')}</div>`;
  return html + `</div>`;
}

function encBackBarHTML() {
  const run = encRun();
  const col = run.collectionId ? window.Encounters.collectionById(campaign, run.collectionId) : null;
  return `<div class="enc-back"><button class="icon-btn" onclick="window.app.encBack()">${icon('arrowLeft')} ${col ? `Back to ${esc(encCollectionName(col))}` : 'Back to encounters'}</button></div>`;
}

// --- Create: collections -------------------------------------------------------------------------

function renderEncCollections() {
  const body = document.getElementById('create-body');
  const E = window.Encounters;
  const cols = E.list(campaign);
  if (!ui.encSelectedCollectionId || !E.collectionById(campaign, ui.encSelectedCollectionId)) ui.encSelectedCollectionId = cols[0] ? cols[0].id : null;
  const col = ui.encSelectedCollectionId ? E.collectionById(campaign, ui.encSelectedCollectionId) : null;
  let html = `<p class="hint">A collection is a table of encounters for one journey. The order sets the index; the die follows from how many there are. In Play, the wagon shows these collections.</p>
    <div class="inline" style="flex-wrap:wrap;margin-bottom:10px">
      ${cols.map((c) => `<button class="icon-btn ${col && c.id === col.id ? 'active' : ''}" onclick="window.app.encSelectCollection('${c.id}')">${esc(encCollectionName(c))} <span class="hint">${c.entries.length}</span></button>`).join('')}
      <button class="icon-btn" onclick="window.app.encNewCollection()">${icon('plus')} New collection</button>
    </div>`;
  if (col) html += encCollectionEditorHTML(col);
  else html += `<p class="empty-hint">No collections yet.</p>`;
  body.innerHTML = html;
}

function encCollectionEditorHTML(col) {
  const E = window.Encounters;
  const table = E.tableOf(campaign, col);
  const r = col.route || {};
  const stop = (s) => (s && s.name) || '';
  const inCol = new Set(col.entries.map((e) => e.encounterId).filter(Boolean));
  const available = Object.values(campaign.entities).filter(E.isEncounter).filter((e) => !inCol.has(e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const kx = col.external && col.external.kodex;
  const armed = ui.encDeleteArm === col.id;
  let html = `<div class="card enc-editor">
    <div class="card-head"><span class="card-title">${icon('wagon')} ${esc(encCollectionName(col))}${kx ? ' <span class="type-tag">Kodex</span>' : ''}</span>
      <span class="inline">${armed
        ? `<button class="icon-btn danger" onclick="window.app.encDeleteCollection('${col.id}')">${icon('trash')} Really delete this collection?</button><button class="icon-btn" onclick="window.app.encDisarm()">Cancel</button>`
        : `<button class="mini-btn" title="Delete collection (the encounters stay)" onclick="window.app.encArmDelete('${col.id}')">${icon('trash')}</button>`}</span></div>
    <div class="form-row"><label>Name</label><input type="text" value="${esc(col.name)}" oninput="window.app.encField('${col.id}','name',this.value)"></div>
    <div class="form-row"><label>Route <span class="hint" style="font-weight:400">(optional, shown in Play)</span></label>
      <div class="enc-route-grid">
        <input type="text" placeholder="From" value="${esc(stop(r.from))}" oninput="window.app.encField('${col.id}','from',this.value)">
        <input type="text" placeholder="Via (comma separated)" value="${esc((r.via || []).map(stop).join(', '))}" oninput="window.app.encField('${col.id}','via',this.value)">
        <input type="text" placeholder="To" value="${esc(stop(r.to))}" oninput="window.app.encField('${col.id}','to',this.value)">
        <input type="text" placeholder="Note, e.g. 3 days, marshy" value="${esc(r.note || '')}" oninput="window.app.encField('${col.id}','note',this.value)">
      </div></div>
    <div class="section-label">Encounters · ${table.dice.die ? `roll ${esc(table.dice.label)}${table.dice.kind === 'reroll' ? ` (${esc(table.dice.note)})` : ''}` : (table.rows.length ? esc(table.dice.note) : 'empty')}</div>
    <div class="enc-table edit">${table.rows.map((row, i) => `
      <div class="enc-row-edit ${row.encounterId ? '' : 'missing'}">
        <span class="enc-index">${row.index}</span><span class="enc-range">${esc(row.range)}</span>
        <span class="enc-name">${row.encounterId ? `<a href="#" onclick="window.app.encEdit('${row.encounterId}');return false">${esc(row.name)}</a>` : esc(row.name)}</span>
        <span class="inline">
          <button class="mini-btn" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="window.app.encMove('${col.id}',${i},-1)">${icon('chevronUp')}</button>
          <button class="mini-btn" title="Move down" ${i === table.rows.length - 1 ? 'disabled' : ''} onclick="window.app.encMove('${col.id}',${i},1)">${icon('chevronDown')}</button>
          <button class="mini-btn" title="Remove from this collection" onclick="window.app.encRemove('${col.id}',${i})">${icon('x')}</button>
        </span>
      </div>`).join('')}</div>
    <div class="inline" style="margin-top:8px">
      <select id="enc-add-sel">${available.length ? available.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('') : '<option value="">No more encounters in the library</option>'}</select>
      <button class="icon-btn" ${available.length ? '' : 'disabled'} onclick="window.app.encAdd('${col.id}')">${icon('plus')} Add to collection</button>
    </div>
    ${kx ? `<p class="hint">Linked to Kodex. Importing it again replaces this table only after you confirm in the review.</p>` : ''}
  </div>`;
  return html;
}

// --- actions ---------------------------------------------------------------------------------------

function encountersActions() {
  const E = window.Encounters;
  return {
    toggleEncounterMode() {
      if (ui.mode !== 'play') { ui.mode = 'play'; ui.encMode = true; } else ui.encMode = !ui.encMode;
      renderAll();
    },
    setCreateScope(scope) {
      ui.createScope = scope === 'encounter' ? 'encounter' : 'campaign';
      renderAll();
    },
    encPickCollection(id) { const r = encRun(); r.collectionId = id; r.started = false; r.roll = null; r.rowIndex = null; r.used = []; r.log = []; ui.curLocation = null; renderAll(); },
    encStart() {
      const r = encRun();
      r.started = true; r.roll = null; r.rowIndex = null; r.used = []; r.log = []; ui.curLocation = null;
      window.app.encRoll();
    },
    encRoll() {
      const r = encRun();
      const col = E.collectionById(campaign, r.collectionId);
      if (!col) return;
      const out = E.rollOn(E.tableOf(campaign, col), null);
      r.roll = out.roll;
      r.rowIndex = out.row ? out.row.index - 1 : null;
      renderAll();
    },
    encEnd() { const r = encRun(); r.started = false; r.roll = null; r.rowIndex = null; r.used = []; r.log = []; renderAll(); },
    encOpen(id) {
      const r = encRun();
      const e = campaign.entities[id];
      if (!e) return;
      if (!r.used.includes(id)) { r.used.push(id); r.log.push(e.name); }
      ui.curLocation = id; ui.curTime = E.ensureCheckpoint(campaign); ui.openEntityIds = []; ui.fullPageEntityId = null;
      renderAll();
      const sc = document.getElementById('main-scroll'); if (sc) sc.scrollTop = 0;
    },
    encBack() { ui.curLocation = null; ui.fullPageEntityId = null; ui.openEntityIds = []; renderAll(); },
    // Create
    encSelectCollection(id) { ui.encSelectedCollectionId = id; ui.encDeleteArm = null; renderAll(); },
    async encNewCollection() { const c = E.createCollection(campaign, { name: 'New collection' }); ui.encSelectedCollectionId = c.id; await refresh(); },
    encField(id, field, value) {
      const col = E.collectionById(campaign, id); if (!col) return;
      if (field === 'name') col.name = value;
      else {
        const old = col.route || { from: null, via: [], to: null, note: '' };
        const mk = (name, prev) => (name.trim() ? Object.assign({}, prev && prev.name === name.trim() ? prev : {}, { name: name.trim() }) : null);
        if (field === 'from') old.from = mk(value, old.from);
        else if (field === 'to') old.to = mk(value, old.to);
        else if (field === 'via') old.via = value.split(',').map((s) => s.trim()).filter(Boolean).map((n) => Object.assign({}, (old.via || []).find((v) => v.name === n) || {}, { name: n }));
        else if (field === 'note') old.note = value;
        col.route = !old.from && !old.to && !(old.via || []).length && !String(old.note || '').trim() ? null : old;
      }
      scheduleFieldSave('enc-col-' + id);
    },
    async encAdd(id) { const sel = document.getElementById('enc-add-sel'); if (!sel || !sel.value) return; E.addEntry(campaign, id, sel.value); await refresh(); },
    async encRemove(id, i) { E.removeEntry(campaign, id, i); await refresh(); },
    async encMove(id, i, d) { E.moveEntry(campaign, id, i, d); await refresh(); },
    encArmDelete(id) { ui.encDeleteArm = id; renderAll(); },
    encDisarm() { ui.encDeleteArm = null; renderAll(); },
    async encDeleteCollection(id) { E.deleteCollection(campaign, id); ui.encDeleteArm = null; ui.encSelectedCollectionId = null; await refresh(); },
    encEdit(id) { ui.createTab = 'entities'; ui.createSelectedEntityId = id; renderAll(); }
  };
}

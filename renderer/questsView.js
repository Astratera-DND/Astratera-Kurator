// Quests UI: the "Quest" tag in every content editor, a searchable quest chooser,
// the ordered item list on a quest's own page, and drag and drop to reorder it.
// The logic (numbering, moving) lives in src/quests.js; this file only draws and calls it.

function qst() { return window.Quests; }

function questName(id) { const e = campaign.entities[id]; return e ? e.name || '(unnamed quest)' : '(deleted quest)'; }

// The tag shown in a block's editor. Untagged: one button. Tagged: quest, place in it, and ways to change.
function questControlHTML(moduleId) {
  const m = (campaign.contentModules || []).find((x) => x.id === moduleId);
  if (!m) return '';
  if (!m.questId || !campaign.entities[m.questId]) {
    return `<div class="quest-ctl" data-mid="${m.id}"><button class="icon-btn" title="Mark this block as part of a quest" onclick="window.app.questPick(event,'${m.id}')">${icon('flag')} Quest…</button></div>`;
  }
  const n = qst().itemsOf(campaign, m.questId).length;
  return `<div class="quest-ctl on" data-mid="${m.id}">
    <span class="quest-chip" title="Quest this block belongs to">${icon('flag')} ${esc(questName(m.questId))}</span>
    <label class="quest-idx" title="Place in the quest. New content is added on top (highest number).">#<input type="number" min="1" max="${n}" value="${m.questIndex || 1}" onchange="window.app.questSetIndex('${m.id}',this.value)"> of ${n}</label>
    <button class="mini-btn" title="Earlier in the quest (lower number)" onclick="window.app.questStep('${m.id}',-1)">${icon('chevronUp')}</button>
    <button class="mini-btn" title="Later in the quest (higher number)" onclick="window.app.questStep('${m.id}',1)">${icon('chevronDown')}</button>
    <button class="mini-btn" title="Choose another quest" onclick="window.app.questPick(event,'${m.id}')">${icon('edit')}</button>
    <button class="mini-btn" title="Remove from the quest" onclick="window.app.questClear('${m.id}')">${icon('x')}</button>
  </div>`;
}

// The yellow "Quest: Name (n)" label next to a block's title (create and play). Click: the quest's flow.
function questTagHTML(moduleId) {
  const m = moduleId && (campaign.contentModules || []).find((x) => x.id === moduleId);
  const q = m && m.questId && campaign.entities[m.questId];
  if (!q) return '';
  const c = colorFor(q.color);
  return ` <span class="quest-tag" role="button" tabindex="0" style="color:${c.fg};background:${c.bg};border-color:${c.fg}55" title="Show every step of this quest" onclick="event.preventDefault();event.stopPropagation();window.app.questFlow(event,'${m.id}')">Quest: ${esc(q.name || '(unnamed quest)')} (${m.questIndex || 1})</span>`;
}
function questTagLine(moduleId) { const t = questTagHTML(moduleId); return t ? `<div class="quest-tagline">${t}</div>` : ''; }

// --- Quest flow: every step of a quest in a row; click a step to go there -------------------

function questFlowTitle(m) {
  return (m.name && m.name.trim()) || (m.text || m.html || (m.lines && m.lines[0] && m.lines[0].text) || '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(untitled)';
}
function questFlowClose() { const el = document.getElementById('quest-flow'); if (el) el.remove(); document.removeEventListener('mousedown', questFlowOutside, true); document.removeEventListener('keydown', questFlowKey, true); }
function questFlowOutside(ev) { if (!ev.target.closest || !ev.target.closest('#quest-flow')) questFlowClose(); }
function questFlowKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); questFlowClose(); } }

function questFlowOpen(ev, moduleId) {
  questFlowClose();
  const m = (campaign.contentModules || []).find((x) => x.id === moduleId);
  const q = m && m.questId && campaign.entities[m.questId];
  if (!q) return;
  const items = qst().itemsOf(campaign, q.id);
  const labels = window.Constants.MODULE_TYPE_LABELS;
  const c = colorFor(q.color);
  const nodes = items.map((it, i) => {
    const placed = (campaign.assignments || []).some((a) => a.moduleId === it.id);
    return `${i ? '<span class="qf-arrow">&#10140;</span>' : ''}<button class="qf-node ${it.id === moduleId ? 'cur' : ''} ${it.complete ? 'done' : ''}" ${placed ? '' : 'disabled title="Not placed anywhere yet"'} data-mid="${it.id}">
      <span class="qf-idx">${it.questIndex || i + 1}</span><span class="qf-type">${esc(labels[it.type] || it.type)}${it.complete ? ' · done' : ''}</span><span class="qf-title">${esc(questFlowTitle(it))}</span></button>`;
  }).join('');
  const el = document.createElement('div');
  el.id = 'quest-flow'; el.className = 'quest-flow';
  el.innerHTML = `<div class="qf-head"><b style="color:${c.fg}">${icon('flag')} Quest: ${esc(q.name || '(unnamed quest)')}</b><span class="cond-hint">${items.length} step${items.length === 1 ? '' : 's'} — click one to go there</span>
    <button class="mini-btn" title="Close" onclick="window.app.questFlowClose()">${icon('x')}</button></div><div class="qf-row">${nodes}</div>`;
  document.body.appendChild(el);
  const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : { left: 80, bottom: 120 };
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 8))}px`;
  const cur = el.querySelector('.qf-node.cur'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.qf-node'); if (!b || b.disabled) return;
    const id = b.dataset.mid; const asg = (campaign.assignments || []).find((a) => a.moduleId === id);
    questFlowClose();
    if (asg) jumpToContent(id, asg);
  });
  setTimeout(() => { document.addEventListener('mousedown', questFlowOutside, true); document.addEventListener('keydown', questFlowKey, true); }, 0);
}

// --- Searchable chooser (quests for a block, or blocks for a quest) ---------------------

let questMenu = null;   // { mode:'quest'|'module', moduleId?, questId?, query, sel }

function questCloseMenu() { const el = document.getElementById('quest-menu'); if (el) el.remove(); questMenu = null; document.removeEventListener('mousedown', questOutside, true); }
function questOutside(ev) { if (!ev.target.closest || !ev.target.closest('#quest-menu')) questCloseMenu(); }

function questMenuRows() {
  const q = (questMenu.query || '').trim().toLowerCase();
  if (questMenu.mode === 'quest') {
    const rows = qst().questList(campaign).filter((e) => !q || e.name.toLowerCase().includes(q))
      .map((e) => ({ id: e.id, label: e.name || '(unnamed quest)', hint: `${qst().itemsOf(campaign, e.id).length} item(s)` }));
    if (q) rows.push({ id: '__new__', label: `New quest “${questMenu.query.trim()}”`, hint: 'create and assign', isNew: true });
    else if (!rows.length) rows.push({ id: '__new__', label: 'New quest…', hint: 'type a name above', isNew: true, disabled: true });
    return rows;
  }
  const labels = window.Constants.MODULE_TYPE_LABELS;
  return (campaign.contentModules || []).filter((m) => m.questId !== questMenu.questId)
    .filter((m) => !q || `${m.name || ''} ${m.text || m.html || ''}`.toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 60)
    .map((m) => ({ id: m.id, label: m.name || (m.text || m.html || '').replace(/\s+/g, ' ').slice(0, 50) || '(untitled)', hint: labels[m.type] || m.type }));
}

function questMenuRender() {
  const el = document.getElementById('quest-menu-list');
  if (!el || !questMenu) return;
  const rows = questMenuRows();
  questMenu.sel = Math.max(0, Math.min(questMenu.sel || 0, rows.length - 1));
  el.innerHTML = rows.map((r, i) => `<button class="cm-item ${i === questMenu.sel ? 'cm-on' : ''}" ${r.disabled ? 'disabled' : ''} data-qi="${r.id}">${r.isNew ? '+ ' : ''}${esc(r.label)} <span class="cond-hint">${esc(r.hint)}</span></button>`).join('') || '<div class="cm-label">Nothing found</div>';
}

function questOpenMenu(ev, state) {
  questCloseMenu();
  questMenu = Object.assign({ query: '', sel: 0 }, state);
  const m = document.createElement('div');
  m.id = 'quest-menu'; m.className = 'cond-menu quest-menu';
  m.innerHTML = `<div class="cm-label">${questMenu.mode === 'quest' ? 'Mark as part of quest' : 'Add content to this quest'}</div>
    <input type="text" id="quest-menu-search" class="director-search" placeholder="${questMenu.mode === 'quest' ? 'Search quests, or type a new name…' : 'Search content…'}" autocomplete="off">
    <div id="quest-menu-list" class="quest-menu-list"></div>`;
  const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : { left: 200, bottom: 200 };
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
  m.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 340))}px`;
  document.body.appendChild(m);
  const inp = document.getElementById('quest-menu-search');
  inp.addEventListener('input', () => { questMenu.query = inp.value; questMenu.sel = 0; questMenuRender(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); questCloseMenu(); return; }
    const n = questMenuRows().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); questMenu.sel = Math.min(n - 1, questMenu.sel + 1); questMenuRender(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); questMenu.sel = Math.max(0, questMenu.sel - 1); questMenuRender(); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = questMenuRows()[questMenu.sel]; if (row && !row.disabled) questMenuPick(row.id); }
  });
  document.getElementById('quest-menu-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-qi]'); if (b && !b.disabled) questMenuPick(b.dataset.qi); });
  setTimeout(() => document.addEventListener('mousedown', questOutside, true), 0);
  questMenuRender();
  inp.focus();
}

function questMenuPick(id) {
  const st = questMenu;
  const name = (st.query || '').trim();
  questCloseMenu();
  if (st.mode === 'quest') {
    let qid = id;
    if (id === '__new__') {
      if (!name) return;
      qid = window.DataModel.createEntity(campaign, { type: 'quest', name }).id;
    }
    qst().assign(campaign, st.moduleId, qid);
  } else {
    qst().assign(campaign, id, st.questId);
  }
  refresh();
}

// --- A quest's own page: its content in order, drag to reorder --------------------------

function questPageHTML(questId) {
  const items = qst().itemsOf(campaign, questId);
  const labels = window.Constants.MODULE_TYPE_LABELS;
  const owner = (m) => window.Query.getModuleAssignments(campaign, m.id).filter((a) => a.entity).map((a) => a.entity.name).join(', ');
  return `${questRewardsHTML(questId)}<div class="section-label">Quest content — in order (1 = first, new content goes on top of the list)</div>
    <p class="hint">Drag the rows to change the order, or edit the number. Any content type can be part of a quest; tag it from its own editor with “Quest…”.</p>
    <div class="quest-list" id="quest-list" data-quest="${questId}">
    ${items.map((m) => `<div class="quest-row" draggable="true" data-mid="${m.id}">
        <span class="mg-grip" title="Drag to reorder">${icon('grip')}</span>
        <input type="number" class="quest-no" min="1" max="${items.length}" value="${m.questIndex}" onchange="window.app.questSetIndex('${m.id}',this.value)">
        <span class="quest-type">${esc(labels[m.type] || m.type)}</span>
        <span class="quest-name">${esc(m.name || (m.text || m.html || '').replace(/\s+/g, ' ').slice(0, 60) || '(untitled)')}</span>
        <span class="cond-hint">${esc(owner(m))}</span>
        <button class="mini-btn" title="Show in the graph" onclick="window.app.showInGraph('${m.id}')">${icon('graph')}</button>
        <button class="mini-btn" title="Remove from this quest" onclick="window.app.questClear('${m.id}')">${icon('x')}</button>
      </div>`).join('') || '<p class="empty-hint">Nothing in this quest yet.</p>'}
    </div>
    <div class="inline"><button class="icon-btn" onclick="window.app.questAddPick(event,'${questId}')">${icon('plus')} Add existing content…</button>
    <button class="icon-btn" title="Export this quest for the players' quest website" onclick="window.app.questExportOpen('${questId}')">${icon('download')} Export for website…</button></div>`;
}

let questDragId = null;
document.addEventListener('dragstart', (ev) => {
  const row = ev.target.closest && ev.target.closest('.quest-row');
  if (!row) return;
  questDragId = row.dataset.mid;
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/quest-row', questDragId); } catch (e) { /* ignore */ }
  row.classList.add('dragging');
});
document.addEventListener('dragend', () => { questDragId = null; document.querySelectorAll('.quest-row').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below')); });
document.addEventListener('dragover', (ev) => {
  const row = ev.target.closest && ev.target.closest('.quest-row');
  if (!questDragId || !row) return;
  ev.preventDefault();
  const r = row.getBoundingClientRect();
  const above = ev.clientY < r.top + r.height / 2;
  document.querySelectorAll('.quest-row').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
  row.classList.add(above ? 'drop-above' : 'drop-below');
});
document.addEventListener('drop', (ev) => {
  const row = ev.target.closest && ev.target.closest('.quest-row');
  if (!questDragId || !row) return;
  ev.preventDefault();
  const r = row.getBoundingClientRect();
  const above = ev.clientY < r.top + r.height / 2;
  const list = Array.from(row.parentElement.querySelectorAll('.quest-row')).map((x) => x.dataset.mid);
  let before = null;
  const i = list.indexOf(row.dataset.mid);
  before = above ? row.dataset.mid : (list[i + 1] || null);
  const id = questDragId; questDragId = null;
  if (before === id) { refresh(); return; }
  qst().moveBefore(campaign, id, before);
  refresh();
});

function questActions() {
  return {
    questRewardAdd(qid) { const r = qst().addReward(campaign.entities[qid], ''); persistSafely(); refresh(); if (r) setTimeout(() => { const el = document.getElementById(`qrw-${r.id}`); if (el) el.focus(); }, 50); },
    questRewardText(qid, rid, v) { qst().updateReward(campaign.entities[qid], rid, { text: v }); scheduleFieldSave(`qrw-${rid}`); },
    questRewardSet(qid, rid, key, v) { qst().updateReward(campaign.entities[qid], rid, { [key]: v }); persistSafely(); refresh(); },
    questRewardMove(qid, rid, d) { qst().moveReward(campaign.entities[qid], rid, d); persistSafely(); refresh(); },
    questRewardRemove(qid, rid) { qst().removeReward(campaign.entities[qid], rid); persistSafely(); refresh(); },
    questExportOpen(id) { questExportId = id; questExportRender(); },
    questExportClose() { questExportClose(); },
    questExportField(moduleId, key, v) { qst().setPublic(campaign, moduleId, { [key]: v }); persistSafely(); questExportRender(); },
    async questExportCopy(all) {
      try { await navigator.clipboard.writeText(questExportJSON(all)); questExportMsg('Copied to the clipboard.'); }
      catch (e) { questExportMsg('Copy failed — use Save instead.'); }
    },
    async questExportSave(all) {
      const q = campaign.entities[questExportId];
      const r = await window.core.saveQuestExport(all ? 'kurator-quests' : (q && q.name) || 'quest', questExportJSON(all));
      if (r && r.ok) questExportMsg(`Saved: ${r.path}`); else if (r && r.error) questExportMsg(`Could not save: ${r.error}`);
    },
    questFlow(ev, moduleId) { questFlowOpen(ev, moduleId); },
    questFlowClose() { questFlowClose(); },
    questPick(ev, moduleId) { ev.stopPropagation(); questOpenMenu(ev, { mode: 'quest', moduleId }); },
    questAddPick(ev, questId) { questOpenMenu(ev, { mode: 'module', questId }); },
    questSetIndex(moduleId, v) { qst().moveTo(campaign, moduleId, v); refresh(); },
    questStep(moduleId, d) { qst().step(campaign, moduleId, d); refresh(); },
    questClear(moduleId) { qst().unassign(campaign, moduleId); refresh(); },
    questAssign(moduleId, questId) { qst().assign(campaign, moduleId, questId); refresh(); }
  };
}

// --- Export for the players' quest website ---------------------------------------------------
// Objective / clue per step are prefilled from the block (title and text) and can be rewritten for players;
// the text a step shows to players never has to be the DM's own notes. Hidden steps are left out of the file.
let questExportId = null;

function questExportClose() { const el = document.getElementById('quest-export'); if (el) el.remove(); questExportId = null; }

function questExportRender() {
  const q = campaign.entities[questExportId];
  const old = document.getElementById('quest-export');
  const keep = old ? old.querySelector('.modal-scroll-body') : null; const top = keep ? keep.scrollTop : 0;
  if (old) old.remove();
  if (!q) { questExportId = null; return; }
  const items = qst().itemsOf(campaign, q.id);
  const rows = items.map((m) => {
    const d = qst().derivedStep(campaign, m); const o = m.questPublic || {};
    const hidden = !!o.hidden;
    return `<div class="qx-row ${hidden ? 'qx-off' : ''}">
      <label class="qx-inc" title="Include this step in the export"><input type="checkbox" ${hidden ? '' : 'checked'} onchange="window.app.questExportField('${m.id}','hidden',!this.checked)"> <b>#${m.questIndex}</b></label>
      <div class="qx-fields">
        <label class="qx-l">Objective</label><input type="text" value="${esc(o.objective || '')}" placeholder="${esc(d.objective)}" ${hidden ? 'disabled' : ''} onchange="window.app.questExportField('${m.id}','objective',this.value)">
        <label class="qx-l">Clue</label><textarea rows="2" placeholder="${esc(d.clue)}" ${hidden ? 'disabled' : ''} onchange="window.app.questExportField('${m.id}','clue',this.value)">${esc(o.clue || '')}</textarea>
        <div class="cond-hint">NPCs: ${esc(d.npcs.join(', ') || '—')} &nbsp;·&nbsp; Location: ${esc(d.location || '—')}</div>
      </div></div>`;
  }).join('') || '<p class="empty-hint">Nothing in this quest yet.</p>';
  const el = document.createElement('div');
  el.id = 'quest-export'; el.className = 'modal-overlay';
  el.onclick = (e) => { if (e.target === el) questExportClose(); };
  el.innerHTML = `<div class="modal-panel modal-panel-wide modal-panel-fixed-footer">
    <div class="modal-head"><span>${icon('flag')} Export for website — ${esc(q.name || '(unnamed quest)')}</span><button class="mini-btn" onclick="window.app.questExportClose()">${icon('x')}</button></div>
    <div class="modal-scroll-body">
      <p class="hint">Rewards in the file: ${esc(qst().rewardsText(campaign, q, true) || 'none') } <span class="cond-hint">(only rewards marked “On website” on the quest page are exported)</span></p>
      <p class="hint">Each step becomes an objective, a clue, its NPCs and its location. Leave a field empty to use what is shown in grey (taken from the block's title and text). Write your own text if the block holds DM-only notes, or untick a step to keep it out of the file.</p>
      ${rows}
    </div>
    <div class="modal-footer">
      <button class="icon-btn" onclick="window.app.questExportCopy(false)">${icon('copy')} Copy JSON</button>
      <button class="icon-btn" onclick="window.app.questExportSave(false)">${icon('download')} Save this quest…</button>
      <button class="icon-btn" title="Every quest in this campaign in one file" onclick="window.app.questExportSave(true)">${icon('download')} Save all quests…</button>
      <span id="quest-export-msg" class="cond-hint"></span><span style="flex:1"></span>
      <button class="icon-btn" onclick="window.app.questExportClose()">Close</button>
    </div></div>`;
  document.body.appendChild(el);
  const sb = el.querySelector('.modal-scroll-body'); if (sb) sb.scrollTop = top;
}

function questExportJSON(all) {
  return JSON.stringify(qst().exportQuests(campaign, all ? null : [questExportId]), null, 2);
}
function questExportMsg(t) { const el = document.getElementById('quest-export-msg'); if (el) el.textContent = t; }

// --- Rewards of a quest ----------------------------------------------------------------------
// The editor on the quest's page. A [[REWARD:questId]] token (Ctrl+Q in a quest block's text) shows these in Play.

function questRewardsHTML(questId) {
  const q = campaign.entities[questId];
  const rewards = qst().rewardsOf(q);
  const checks = campaign.dcChecks || [];
  const dcLabel = (c) => window.Conditions.dcCheckLabel(c);
  const rows = rewards.map((r, i) => {
    const linked = r.dcCheckId && checks.some((c) => c.id === r.dcCheckId);
    return `<div class="qrw-row">
      <div class="qrw-join">${i === 0 ? '<span class="cond-hint">first</span>' : `<select title="How this reward relates to the one above" onchange="window.app.questRewardSet('${questId}','${r.id}','joiner',this.value)"><option value="and" ${r.joiner !== 'or' ? 'selected' : ''}>and</option><option value="or" ${r.joiner === 'or' ? 'selected' : ''}>or</option></select>`}</div>
      <div class="qrw-main">
        <textarea id="qrw-${r.id}" class="mention-field" rows="2" placeholder="The reward — @ mention, Ctrl+B/I format" oninput="window.app.questRewardText('${questId}','${r.id}',this.value)">${esc(r.text)}</textarea>
        <div class="qrw-opts">
          <label class="qrw-dc" title="Tie this reward to a DC check: Play shows the check first and the reward once it has this result">DC check
            <select onchange="window.app.questRewardSet('${questId}','${r.id}','dcCheckId',this.value)"><option value="">none</option>${checks.map((c) => `<option value="${c.id}" ${r.dcCheckId === c.id ? 'selected' : ''}>${esc(dcLabel(c))}</option>`).join('')}</select></label>
          ${linked ? `<label class="qrw-dc">revealed when it <select onchange="window.app.questRewardSet('${questId}','${r.id}','dcWhen',this.value)">${Object.keys(qst().DC_WHEN_LABELS).map((k) => `<option value="${k}" ${r.dcWhen === k ? 'selected' : ''}>${qst().DC_WHEN_LABELS[k]}</option>`).join('')}</select></label>` : ''}
          <button class="mini-btn txt qrw-pub ${r.publish ? 'on' : ''}" title="${r.publish ? 'The players know about this reward: it is included in the website export. Click to keep it out.' : 'Not exported. Click to tell the website export that players are aware of this reward.'}" onclick="window.app.questRewardSet('${questId}','${r.id}','publish',${!r.publish})">${icon(r.publish ? 'check' : 'x')} ${r.publish ? 'On website' : 'Not on website'}</button>
        </div>
      </div>
      <div class="qrw-tools">
        <button class="mini-btn" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="window.app.questRewardMove('${questId}','${r.id}',-1)">${icon('chevronUp')}</button>
        <button class="mini-btn" title="Move down" ${i === rewards.length - 1 ? 'disabled' : ''} onclick="window.app.questRewardMove('${questId}','${r.id}',1)">${icon('chevronDown')}</button>
        <button class="mini-btn" title="Delete this reward" onclick="window.app.questRewardRemove('${questId}','${r.id}')">${icon('trash')}</button>
      </div></div>`;
  }).join('');
  return `<div class="section-label">Rewards</div>
    <p class="hint">Put a reward marker into any step of this quest (Ctrl+Q, then R, or right-click &gt; Quest reward) and Play shows these there. Rewards read in this order, joined by <b>and</b> / <b>or</b>. A reward tied to a DC check shows the check first and the reward once the roll turns out right. Only rewards marked <b>On website</b> go into the website export.</p>
    <div class="qrw-list">${rows || '<p class="empty-hint">No rewards yet.</p>'}</div>
    <div class="inline"><button class="icon-btn" onclick="window.app.questRewardAdd('${questId}')">${icon('plus')} Add reward</button></div>`;
}

// The quest a text field's block belongs to (null when the field is not part of a quest block).
function questFieldModuleId(ta) {
  if (!ta) return null;
  const mods = campaign.contentModules || [];
  let id = ta.id || '';
  if (id.startsWith('lib-field-')) id = id.slice(10);
  if (mods.some((m) => m.id === id)) return id;
  const hit = String(ta.getAttribute('oninput') || '').match(/'(mod_[A-Za-z0-9_]+)'/);
  if (hit && mods.some((m) => m.id === hit[1])) return hit[1];
  if (ta.id === 'arr-text') {
    for (let p = ta.parentElement; p; p = p.parentElement) { const c = p.querySelector('.quest-ctl[data-mid]'); if (c) return c.dataset.mid; }
  }
  return null;
}
function questOfField(ta) {
  const mid = questFieldModuleId(ta);
  const m = mid && (campaign.contentModules || []).find((x) => x.id === mid);
  const q = m && m.questId && campaign.entities[m.questId];
  return q && q.type === 'quest' ? q : null;
}

// Puts the reward marker of the field's quest at the cursor.
function questInsertReward(ta, start, end) {
  const q = questOfField(ta);
  if (!q) { if (window.Health) window.Health.notice('Mark this block as part of a quest first (the Quest… button under it), then add the reward marker.'); return; }
  const token = `[[REWARD:${q.id}]]`;
  const a = start == null ? ta.selectionStart : start, b = end == null ? ta.selectionEnd : end;
  ta.focus();
  ta.value = ta.value.slice(0, a) + token + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + token.length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  if (!qst().rewardsOf(q).length && window.Health) window.Health.notice(`Reward marker added. "${q.name || 'The quest'}" has no rewards yet — add them on the quest's page.`);
}

// Ctrl+Q: a small menu of quest tools for the field you are typing in (for now: the reward marker).
let qQuick = null;   // { ta, start, end }
function questQuickClose() { const el = document.getElementById('quest-qmenu'); if (el) el.remove(); qQuick = null; document.removeEventListener('keydown', questQuickKey, true); document.removeEventListener('mousedown', questQuickOutside, true); }
function questQuickOutside(ev) { if (!ev.target.closest || !ev.target.closest('#quest-qmenu')) questQuickClose(); }
function questQuickRun(act) {
  const t = qQuick; questQuickClose();
  if (t && act === 'reward') questInsertReward(t.ta, t.start, t.end);
}
function questQuickKey(ev) {
  if (!qQuick) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape') { ev.preventDefault(); ev.stopPropagation(); const ta = qQuick.ta; questQuickClose(); ta.focus(); return; }
  if (k === 'r' || k === 'enter') { ev.preventDefault(); ev.stopPropagation(); questQuickRun('reward'); return; }
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && k.length === 1) { ev.preventDefault(); ev.stopPropagation(); }   // keep stray letters out of the text while the menu is open
}
function questQuickOpen(ta) {
  questQuickClose();
  const q = questOfField(ta);
  qQuick = { ta, start: ta.selectionStart, end: ta.selectionEnd };
  const el = document.createElement('div');
  el.id = 'quest-qmenu'; el.className = 'cond-menu';
  el.innerHTML = q
    ? `<div class="cm-label">${icon('flag')} Quest tools — ${esc(q.name || '(unnamed quest)')}</div>
       <button class="cm-item cm-on" onclick="questQuickRun('reward')"><span>Reward</span><span class="cm-key">R</span></button>`
    : `<div class="cm-label">Quest tools</div><div class="cm-label" style="text-transform:none">Mark this block as part of a quest first (Quest… under it).</div>`;
  document.body.appendChild(el);
  const r = ta.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.left + 24, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(r.top + 36, window.innerHeight - el.offsetHeight - 8))}px`;
  if (!q) { setTimeout(questQuickClose, 2600); qQuick = null; return; }
  document.addEventListener('keydown', questQuickKey, true);
  setTimeout(() => document.addEventListener('mousedown', questQuickOutside, true), 0);
}
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'q') return;
  const ta = ev.target;
  if (!ta || ta.tagName !== 'TEXTAREA' || ui.mode !== 'create') return;
  ev.preventDefault(); ev.stopPropagation();
  questQuickOpen(ta);
}, true);

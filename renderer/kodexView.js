// Kodex connection UI: the "Kodex" window (import a package, send to Kodex), the review/merge screen
// every incoming package passes through, and the small "Open in Kodex" link on linked entities.
// The data logic lives in src/kodexSync.js (shared with the tests); files, inbox, push are in main.js.

function kxs() { return window.KodexSync; }
function kx() { return ui.kodex; }

const KX_STATUS = {
  new: ['New', 'kx-new'], kodex: ['Changed in Kodex', 'kx-kodex'], kurator: ['Changed in Kurator', 'kx-kurator'],
  conflict: ['Conflict', 'kx-conflict'], same: ['Same change', 'kx-same'], unchanged: ['Unchanged', 'kx-same'],
  missing: ['Deleted in Kurator', 'kx-kurator'], gone: ['Gone from Kodex', 'kx-kurator']
};
const KX_CHOICES = [['kodex', 'Take Kodex'], ['kurator', 'Keep Kurator'], ['both', 'Keep both'], ['skip', 'Skip']];

function kodexLinkFor(entity) {
  const k = entity && entity.external && entity.external.kodex;
  if (!k || !k.id) return '';
  return `astratera-lore://open/${encodeURIComponent(k.workspace || '')}/${k.id}`;
}

function kxOpenModal() {
  const m = document.getElementById('kodex-modal');
  if (m) m.style.display = 'flex';
}

function kxEntityRows(plan) {
  return plan.entities.map((pe) => {
    const counts = {};
    pe.targets.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
    return { pe, counts };
  });
}

function kxBadges(counts) {
  return ['conflict', 'new', 'kodex', 'kurator'].filter((s) => counts[s]).map((s) => `<span class="kx-badge ${KX_STATUS[s][1]}" title="${KX_STATUS[s][0]}">${counts[s]}</span>`).join('');
}

function kxHomeHTML() {
  const st = kx();
  const cp = campaign.meta && ui.activeCampaignName;
  const running = st.status && st.status.running;
  const inbox = st.inbox || [];
  return `
    <div class="section-label" style="margin-top:0">Import from Kodex</div>
    <p class="hint">A Kodex package is reviewed here before anything is written. Nothing is overwritten or deleted without your choice, and importing the same package twice changes nothing.</p>
    <div class="inline" style="flex-wrap:wrap;gap:6px">
      <button class="icon-btn" onclick="window.app.kxPick(false)">${icon('download')} Package file (.zip / .json)…</button>
      <button class="icon-btn" onclick="window.app.kxPick(true)">${icon('download')} Package folder…</button>
    </div>
    ${appSettings.kodexInboxPath ? `
      <div class="section-label">Inbox <span class="hint" style="text-transform:none">${esc(appSettings.kodexInboxPath)}</span></div>
      ${inbox.length ? inbox.map((i) => `<div class="kx-inbox"><span>${esc(i.name)}</span><span class="hint">${esc(new Date(i.mtime).toLocaleString())}</span><button class="icon-btn" onclick="window.app.kxOpenInbox('${esc(i.key).replace(/'/g, '&#39;')}')">Review…</button></div>`).join('') : '<p class="hint">No new packages waiting.</p>'}
    ` : '<p class="hint">Tip: set the Kodex inbox folder in Settings and packages Kodex drops there show up here automatically.</p>'}
    <div class="section-label">Send to Kodex</div>
    <p class="hint">${running ? `Kodex is running${st.status.context && st.status.context.workspace ? ` (workspace “${esc(st.status.context.workspace)}”)` : ''}. A push opens the review screen in Kodex.` : 'Kodex is not running right now. You can save a package file and import it in Kodex.'}</p>
    <div class="inline" style="flex-wrap:wrap;gap:6px">
      <button class="icon-btn" onclick="window.app.kxOpenSend()">${icon('chevronRight')} Choose what to send…</button>
    </div>
    <p class="hint" style="margin-top:10px">Campaign: ${esc(cp || '')}</p>`;
}

// --- Send window: items, filters, sort, grouping, selection -----------------------------------------
const KX_KIND_LABEL = { npc: 'NPC', location: 'Location', encounter: 'Encounter', quest: 'Quest', check: 'DC check' };
const KX_KIND_ORDER = ['npc', 'location', 'encounter', 'quest', 'check'];

// Group order key: the entity-group tree order (top-level order, then subgroup order), ungrouped last.
function kxGroupSortKey(groupId) {
  const groups = campaign.entityGroups || [];
  const chain = []; const seen = new Set(); let g = groups.find((x) => x.id === groupId);
  while (g && !seen.has(g.id)) { seen.add(g.id); chain.unshift(g); g = g.parentId ? groups.find((x) => x.id === g.parentId) : null; }
  return chain.length ? chain.map((x) => String(x.order).padStart(5, '0')).join('.') : '99999';
}

const KX_MG_LEVELS = 6; // the Manage groups level colours (.mg-level-N in styles.css)
function kxGroupDepth(groupId) {
  const groups = campaign.entityGroups || []; let d = 0; const seen = new Set(); let g = groups.find((x) => x.id === groupId);
  while (g && g.parentId && !seen.has(g.id)) { seen.add(g.id); d++; g = groups.find((x) => x.id === g.parentId); }
  return d;
}

function kxSendItems() {
  const st = kx(); const ex = st.exportPreview; if (!ex) return [];
  const items = (ex.pkg.entities || []).map((pe) => {
    const ent = campaign.entities[pe.kuratorId] || null;
    const kind = ent && window.Encounters.isEncounter(ent) ? 'encounter' : (ent ? ent.type : (pe.kind === 'encounter' ? 'encounter' : pe.kind)) || 'npc';
    const keys = Object.keys(pe.targets || {});
    const keyText = keys.map((k) => (pe.targets[k].title && /\.k_|:k_/.test(k)) || k === 'note:notes' ? (pe.targets[k].title || k) : k.replace(/^profile\./, '')).join(', ');
    const gid = ent && ent.groupId && (campaign.entityGroups || []).some((g) => g.id === ent.groupId) ? ent.groupId : null;
    return { key: pe.kuratorId, kind, name: pe.name || (ent && ent.name) || '', ent, isNew: !!pe.isNew, n: keys.length, keyText, groupId: gid, groupName: gid ? window.Query.getGroupPathName(campaign, gid) : 'Ungrouped', groupSort: gid ? kxGroupSortKey(gid) : '99999', depth: gid ? kxGroupDepth(gid) : -1 };
  });
  (ex.pkg.dcChecks || []).forEach((d) => items.push({ key: 'dc:' + d.kuratorId, kind: 'check', name: d.name || d.checkType || 'DC check', ent: null, isNew: !d.kodexId, n: 1, keyText: d.checkType || '', groupId: null, groupName: 'DC checks', groupSort: '99998', depth: -1 }));
  return items;
}

function kxSendVisible() {
  const st = kx(); const q = kxFold(st.sendQ || '').split(/\s+/).filter(Boolean);
  let list = kxSendItems().filter((it) => {
    if (st.sendKind && st.sendKind !== 'all' && it.kind !== st.sendKind) return false;
    if (st.sendStatus === 'new' && !it.isNew) return false;
    if (st.sendStatus === 'changed' && it.isNew) return false;
    if (st.sendStatus === 'selected' && !st.sendSel[it.key]) return false;
    if (q.length) { const hay = kxFold(`${it.name} ${it.keyText} ${it.groupName} ${KX_KIND_LABEL[it.kind] || ''}`); if (!q.every((w) => hay.includes(w))) return false; }
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const cmp = st.sendSort === 'type' ? (a, b) => (KX_KIND_ORDER.indexOf(a.kind) - KX_KIND_ORDER.indexOf(b.kind)) || byName(a, b)
    : st.sendSort === 'status' ? (a, b) => (Number(b.isNew) - Number(a.isNew)) || (b.n - a.n) || byName(a, b)
    : byName;
  list.sort(cmp);
  // sections
  const mode = st.sendGroup || 'group';
  if (mode === 'none') return [{ id: '', label: '', depth: -1, items: list }];
  const secs = new Map();
  list.forEach((it) => {
    const id = mode === 'type' ? it.kind : (it.groupId || (it.kind === 'check' ? '__checks' : '__none'));
    if (!secs.has(id)) secs.set(id, { id, label: mode === 'type' ? KX_KIND_LABEL[it.kind] : it.groupName, sort: mode === 'type' ? String(KX_KIND_ORDER.indexOf(it.kind)).padStart(2, '0') : it.groupSort, depth: mode === 'type' ? -1 : it.depth, items: [] });
    secs.get(id).items.push(it);
  });
  return [...secs.values()].sort((a, b) => a.sort.localeCompare(b.sort));
}

function kxSendRowHTML(it, sec) {
  const st = kx(); const on = !!st.sendSel[it.key];
  const lvl = sec && sec.depth >= 0 ? ` mg-level-${sec.depth % KX_MG_LEVELS} kx-tint` : '';
  const ind = sec && sec.label !== '' ? ' kx-indent' : '';
  const badge = it.ent ? entityBadge(it.ent, 20) : `<span class="kx-sbadge">${icon('dice')}</span>`;
  return `<div class="kx-srow${ind}${lvl} ${on ? 'on' : ''}" data-key="${esc(it.key)}" onclick="window.app.kxSendClick(event,this.dataset.key)">
    <input type="checkbox" tabindex="-1" ${on ? 'checked' : ''} style="pointer-events:none">${badge}
    <span class="kx-sname">${esc(it.name || '(unnamed)')}</span>
    <span class="kx-skind">${KX_KIND_LABEL[it.kind] || it.kind}</span>
    ${it.isNew ? '<span class="kx-badge kx-new">new in Kodex</span>' : `<span class="kx-badge kx-kurator" title="Changes since the last transfer">${it.n} change${it.n === 1 ? '' : 's'}</span>`}
    ${it.keyText ? `<span class="hint kx-skeys">${esc(it.keyText)}</span>` : ''}</div>`;
}

function kxSendPaint() {
  const st = kx(); if (!st || st.mode !== 'send') return;
  const list = document.getElementById('kx-send-list'); if (!list) return;
  const secs = kxSendVisible();
  const all = kxSendItems();
  st.sendOrder = [];
  const keep = list.scrollTop;
  list.innerHTML = secs.length && secs.some((x) => x.items.length) ? secs.map((sec) => {
    const collapsed = !!sec.id && !!(st.sendCollapsed || {})[sec.id] && !st.sendQ;
    if (!collapsed) sec.items.forEach((it) => st.sendOrder.push(it.key));
    const n = sec.items.filter((it) => st.sendSel[it.key]).length;
    const hl = sec.depth >= 0 ? ` mg-level-${sec.depth % KX_MG_LEVELS} kx-tint` : '';
    const head = sec.label !== '' || sec.id ? `<div class="kx-shead${hl}" style="padding-left:${8 + Math.max(sec.depth, 0) * 12}px" onclick="window.app.kxSendCollapse('${esc(sec.id)}')">${icon(collapsed ? 'chevronRight' : 'chevronDown')}
      <input type="checkbox" ${n === sec.items.length ? 'checked' : ''} ${n && n < sec.items.length ? 'data-partial="1"' : ''} onclick="event.stopPropagation();window.app.kxSendSection('${esc(sec.id)}',this.checked)" title="Select / clear this whole section (only what is shown)">
      <span>${esc(sec.label)}</span><span class="hint">${n}/${sec.items.length}</span></div>` : '';
    return head + (collapsed ? '' : sec.items.map((it) => kxSendRowHTML(it, sec)).join(''));
  }).join('') : `<p class="hint" style="padding:10px">${all.length ? 'Nothing matches the filters.' : 'Nothing to send: everything is already in sync.'}</p>`;
  list.scrollTop = keep;
  if (st.scrollTo) {
    const row = [...list.querySelectorAll('.kx-srow')].find((r) => r.dataset.key === st.scrollTo);
    if (row) { list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2); row.classList.add('kx-focus'); }
    st.scrollTo = null;
  }
  list.querySelectorAll('input[data-partial]').forEach((c) => { c.indeterminate = true; });
  const total = all.length; const sel = all.filter((it) => st.sendSel[it.key]);
  const shownKeys = new Set(secs.flatMap((x) => x.items.map((i) => i.key)));
  const hidden = sel.filter((it) => !shownKeys.has(it.key)).length;
  const count = document.getElementById('kx-send-count');
  if (count) count.textContent = `${sel.length} selected of ${total}${hidden ? ` · ${hidden} hidden by the filters are still included` : ''}`;
  const running = st.status && st.status.running;
  const act = document.getElementById('kx-send-actions');
  if (act) act.innerHTML = `<button class="icon-btn tr-go" ${sel.length && running ? '' : 'disabled'} onclick="window.app.kxSend('push')">Send ${sel.length} to Kodex${running ? '' : ' (not running)'}</button>
      <button class="icon-btn" ${sel.length ? '' : 'disabled'} onclick="window.app.kxSend('file')">${icon('download')} Save package file…</button>
      <button class="icon-btn" onclick="window.app.kxHome()">Back</button>`;
}

function kxSendHTML() {
  const st = kx();
  if (!st.exportPreview) return '<p class="hint">Preparing…</p>';
  const opt = (cur, pairs) => pairs.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  const ex = st.exportPreview;
  return `
    <p class="hint">${st.focusId ? 'Everything is listed so the one you chose can be sent again even if it is unchanged. ' : 'Only what changed in Kurator since the last transfer is listed, plus entities Kodex does not have yet. '}Kodex shows its own review before it applies anything.</p>
    <div class="kx-sbar">
      <input type="text" id="kx-send-q" value="${esc(st.sendQ || '')}" placeholder="Search name, group or what changed" oninput="window.app.kxSendSet('sendQ',this.value)" style="flex:1;min-width:160px">
      <select title="Show only…" onchange="window.app.kxSendSet('sendKind',this.value)">${opt(st.sendKind || 'all', [['all', 'All types'], ['npc', 'NPCs'], ['location', 'Locations'], ['encounter', 'Encounters'], ['check', 'DC checks']])}</select>
      <select title="Status" onchange="window.app.kxSendSet('sendStatus',this.value)">${opt(st.sendStatus || 'all', [['all', 'Any status'], ['new', 'New in Kodex'], ['changed', 'Changed'], ['selected', 'Selected only']])}</select>
      <select title="Sort" onchange="window.app.kxSendSet('sendSort',this.value)">${opt(st.sendSort || 'name', [['name', 'Sort: name'], ['type', 'Sort: type'], ['status', 'Sort: new / most changes']])}</select>
      <select title="Group by" onchange="window.app.kxSendSet('sendGroup',this.value)">${opt(st.sendGroup || 'group', [['group', 'Group: entity groups'], ['type', 'Group: type'], ['none', 'No grouping']])}</select>
    </div>
    <div class="kx-sbar">
      <label class="tr-ex"><input type="checkbox" ${st.onlyChanged ? 'checked' : ''} onchange="window.app.kxSendOnlyChanged(this.checked)"> only changes</label>
      <button class="icon-btn" onclick="window.app.kxSendBulk('shown',true)">Select shown</button>
      <button class="icon-btn" onclick="window.app.kxSendBulk('shown',false)">Clear shown</button>
      <button class="icon-btn" onclick="window.app.kxSendBulk('invert')">Invert shown</button>
      <button class="icon-btn" onclick="window.app.kxSendBulk('all',false)">Clear all</button>
      <span id="kx-send-count" class="hint" style="margin-left:auto"></span>
    </div>
    <div id="kx-send-list" class="kx-slist" tabindex="0"></div>
    <p class="hint" style="margin:4px 0 0">Click a row to tick it · Shift+click ticks a range · Ctrl/Cmd+click selects only that one · the box on a header ticks the whole section.</p>
    ${ex.pkg.warnings.length ? `<p class="hint">${esc(ex.pkg.warnings.join(' '))}</p>` : ''}
    ${st.sendResult ? `<div class="tr-warn" style="margin-top:10px">${esc(st.sendResult)}</div>` : ''}
    <div id="kx-send-actions" class="inline" style="flex-wrap:wrap;gap:6px;margin-top:12px"></div>`;
}

function renderKodexModal() {
  const st = kx();
  const body = document.getElementById('kodex-body');
  const foot = document.getElementById('kodex-footer');
  const title = document.getElementById('kodex-title');
  if (!st || !body || !foot) return;
  const keep = body.querySelector('.kx-left') ? body.querySelector('.kx-left').scrollTop : 0;
  if (st.mode === 'review') {
    title.textContent = `Import from Kodex${st.name ? ` · ${st.name}` : ''}`;
    body.innerHTML = kxReviewHTML();
    foot.innerHTML = `<button class="icon-btn tr-go" style="width:auto;padding:8px 18px" onclick="window.app.kxApply()">Apply import</button><button class="icon-btn" onclick="window.app.kxCancel()">Cancel</button><span class="hint">A backup is taken first.</span>`;
  } else if (st.mode === 'report') {
    title.textContent = 'Import from Kodex';
    body.innerHTML = kxReportHTML();
    foot.innerHTML = `<button class="icon-btn" onclick="window.app.closeKodex()">Close</button>`;
  } else if (st.mode === 'pick') {
    title.textContent = 'Find in Kodex';
    body.innerHTML = kxPickHTML();
    foot.innerHTML = `<button class="icon-btn" onclick="window.app.closeKodex()">Cancel</button>`;
    kxPickPaint();
  } else if (st.mode === 'send') {
    title.textContent = 'Send to Kodex';
    body.innerHTML = kxSendHTML();
    foot.innerHTML = '';
    kxSendPaint();
  } else {
    title.textContent = 'Kodex';
    body.innerHTML = kxHomeHTML();
    foot.innerHTML = '';
  }
  const left = body.querySelector('.kx-left'); if (left) left.scrollTop = keep;
}

function kxReplan(keepFrom) {
  const st = kx();
  const old = keepFrom || st.plan;
  const plan = kxs().planImport(campaign, st.pkg, { checkpointId: old.checkpointId, checkpointLabel: old.checkpointLabel, useMilestones: old.useMilestones, links: st.links || {}, collectionLinks: st.colLinks || {} });
  if (plan.error) { window.Health.notice(plan.error); return old; }
  // keep the user's decisions for rows that still exist
  plan.entities.forEach((pe) => {
    const o = old.entities.find((x) => x.kodexId === pe.kodexId);
    if (!o) return;
    pe.targets.forEach((t) => { const ot = o.targets.find((x) => x.key === t.key); if (ot && ot.status === t.status && ot.choice !== undefined && !t.scoped) t.choice = ot.choice; });
  });
  (plan.collections || []).concat(plan.dcChecks || []).forEach((c) => {
    const o = (old.collections || []).concat(old.dcChecks || []).find((x) => x.kodexId === c.kodexId);
    if (o && o.status === c.status && o.choice !== undefined) c.choice = o.choice;
  });
  return plan;
}

async function kxStart(pkg, name, extra) {
  await persistSafely();
  // the hidden encounter checkpoint is never a place for normal content: use the campaign's own current milestone
  const curTime = isEncScope() ? ((ui.scopeSaved || {}).campaign || {}).curTime : ui.curTime;
  const cur = curTime && (campaign.checkpoints || []).some((c) => c.id === curTime && !c.encounter) ? curTime : undefined;
  const plan = kxs().planImport(campaign, pkg, { checkpointId: cur });
  if (plan.error) { window.Health.notice(plan.error); return; }
  const first = plan.entities[0] || (plan.collections || [])[0] || (plan.dcChecks || [])[0];
  ui.kodex = Object.assign({ mode: 'review', pkg, name: name || '', plan, selected: first ? first.kodexId : null, filter: 'all' }, extra || {});
  kxOpenModal();
  renderKodexModal();
}

async function kxCropToEntity(entityId, srcPath) {
  const res = await window.core.kodexReadImage(srcPath);
  if (!res || res.error) return false;
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = res.dataUrl; });
  const size = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_CROP_OUTPUT_SIZE; canvas.height = IMAGE_CROP_OUTPUT_SIZE;
  canvas.getContext('2d').drawImage(img, (img.naturalWidth - size) / 2, (img.naturalHeight - size) / 2, size, size, 0, 0, IMAGE_CROP_OUTPUT_SIZE, IMAGE_CROP_OUTPUT_SIZE);
  const saved = await window.core.saveCroppedEntityImage(entityId, canvas.toDataURL('image/jpeg', 0.85));
  if (!saved || saved.error) return false;
  window.DataModel.setEntityImage(campaign, entityId, saved.filename);
  return true;
}

// Polls Kodex until the pushed package is applied (then remembers it as transferred) or cancelled (then forgets it).
function kxWatchPush(importId, ex) {
  let tries = 0;
  const tick = async () => {
    tries++;
    let r = null;
    try { r = await window.core.kodexPushStatus(importId); } catch { /* try again */ }
    if (r && r.ok && r.status === 'applied') {
      ex.commit({ ids: r.ids || {} });
      await persistSafely();
      renderAll();
      if (ui.kodex && ui.kodex.mode === 'send') window.app.kxBuildExport();
      return;
    }
    if (r && r.ok && r.status === 'cancelled') return;
    if (tries < 450) setTimeout(tick, 4000);      // about 30 minutes
  };
  setTimeout(tick, 4000);
}

function kodexActions() {
  return {
    async openKodex() {
      ui.kodex = { mode: 'home', inbox: [], status: null };
      kxOpenModal(); renderKodexModal();
      try { ui.kodex.inbox = await window.core.kodexInboxList(); } catch { /* ignore */ }
      try { ui.kodex.status = await window.core.kodexStatus(); } catch { /* ignore */ }
      if (ui.kodex && ui.kodex.mode === 'home') renderKodexModal();
    },
    closeKodex() {
      const st = kx();
      if (st && st.importId && st.mode === 'review') window.core.kodexImportFinished(st.importId, { cancelled: true });
      ui.kodex = null;
      const m = document.getElementById('kodex-modal'); if (m) m.style.display = 'none';
    },
    kxHome() { const st = kx(); if (!st) return; st.mode = 'home'; renderKodexModal(); },
    async kxPick(folder) {
      const r = await window.core.kodexPickPackage(folder);
      if (!r || r.cancelled) return;
      if (r.error) { window.Health.notice(`Couldn't read that package: ${r.error}`); return; }
      await kxStart(r.pkg, r.name, {});
    },
    async kxOpenInbox(key) {
      const r = await window.core.kodexInboxOpen(key);
      if (!r || r.error) { window.Health.notice((r && r.error) || 'Could not open that package.'); return; }
      await kxStart(r.pkg, r.name, { inboxKey: key });
    },
    async kxCancel() {
      const st = kx();
      if (st && st.inboxKey) { /* leave it in the inbox list */ }
      window.app.closeKodex();
    },
    kxSelect(id) { kx().selected = id; renderKodexModal(); },
    kxFilter(f) { kx().filter = f; renderKodexModal(); },
    kxLink(id, v) {
      const st = kx();
      if (!st.links) st.links = {};
      if (v === 'link') delete st.links[id]; else st.links[id] = v;
      st.plan = kxReplan(st.plan);
      renderKodexModal();
    },
    kxColLink(id, v) {
      const st = kx();
      if (!st.colLinks) st.colLinks = {};
      if (v === 'link') delete st.colLinks[id]; else st.colLinks[id] = v;
      st.plan = kxReplan(st.plan);
      renderKodexModal();
    },
    kxColChoice(id, v) {
      const c = (kx().plan.collections || []).concat(kx().plan.dcChecks || []).find((x) => x.kodexId === id);
      if (c) c.choice = v || null;
      renderKodexModal();
    },
    kxChoice(id, i, v) {
      const pe = kx().plan.entities.find((e) => e.kodexId === id);
      if (pe && pe.targets[i]) pe.targets[i].choice = v || null;
      renderKodexModal();
    },
    kxSetCheckpoint(v) { const st = kx(); st.plan.checkpointId = v; st.plan = kxReplan(st.plan); renderKodexModal(); },
    kxCheckpointLabel(v) { kx().plan.checkpointLabel = v; },
    kxMilestones(on) { const st = kx(); st.plan.useMilestones = !!on; st.plan = kxReplan(st.plan); renderKodexModal(); },
    kxBulk(what) {
      (kx().plan.collections || []).concat(kx().plan.dcChecks || []).forEach((c) => {
        if (what === 'kodex' && (c.status === 'kodex' || c.status === 'new')) c.choice = 'kodex';
        if (what === 'conflict-kurator' && c.status === 'conflict') c.choice = 'kurator';
      });
      kx().plan.entities.forEach((pe) => pe.targets.forEach((t) => {
        if (what === 'kodex' && (t.status === 'kodex' || t.status === 'new')) t.choice = 'kodex';
        if (what === 'conflict-kurator' && t.status === 'conflict') t.choice = 'kurator';
      }));
      renderKodexModal();
    },
    async kxApply() {
      const st = kx();
      if (!st || st.applying) return;
      st.applying = true;
      try {
        try { await window.core.backupNow(); } catch { /* a failed snapshot must not block, but the user is told */ window.Health.notice('The backup snapshot could not be written; importing anyway.'); }
        const report = kxs().applyImport(campaign, st.pkg, st.plan, {});
        if (report.error) { window.Health.notice(report.error); st.applying = false; return; }
        report.imagesSaved = 0;
        for (const img of report.pendingImages) {
          if (img.path) { try { if (await kxCropToEntity(img.entityId, img.path)) report.imagesSaved++; } catch { report.warnings.push('An image could not be read.'); } }
        }
        await persistSafely();
        renderAll();
        if (st.inboxKey) await window.core.kodexInboxDone(st.inboxKey);
        if (st.importId) window.core.kodexImportFinished(st.importId, { created: report.created.length, updated: report.updated.length, conflictsOpen: report.conflictsOpen.length });
        st.importId = null;
        st.report = report; st.mode = 'report'; st.applying = false;
        renderKodexModal();
      } catch (err) {
        st.applying = false;
        window.Health.notice(`The import stopped: ${err.message}. The backup taken just before is in the backups folder.`);
        if (window.Health) window.Health.report('kodex-import-failed', { err: window.Health.errorInfo(err) });
      }
    },
    // --- Kurator -> Kodex ---
    kxOpenSend(focusId) {
      const st = kx(); st.mode = 'send'; st.sendSel = {}; st.sendResult = ''; st.focusId = focusId || null; st.scrollTo = focusId || null;
      st.onlyChanged = !focusId; st.sendQ = ''; st.sendKind = 'all'; st.sendStatus = 'all'; st.sendSort = st.sendSort || 'name'; st.sendGroup = st.sendGroup || 'group'; st.sendCollapsed = st.sendCollapsed || {}; st.sendAnchor = null;
      if (focusId) { const e = campaign.entities[focusId]; if (e && e.groupId) st.sendCollapsed[e.groupId] = false; }
      window.app.kxBuildExport();
    },
    // From an entity's header: open the send window with just that entity ticked.
    async kxSendEntity(entityId) {
      await persistSafely();
      ui.kodex = { mode: 'home', inbox: [], status: null };
      kxOpenModal();
      try { ui.kodex.status = await window.core.kodexStatus(); } catch { /* ignore */ }
      if (!ui.kodex) return;
      window.app.kxOpenSend(entityId);
      const e = campaign.entities[entityId];
      if (e && !(ui.kodex.exportPreview.pkg.entities || []).some((x) => x.kuratorId === entityId)) ui.kodex.sendResult = `“${e.name || 'This entity'}” has nothing to send yet (no text in the fields Kodex takes).`;
      if (ui.kodex.sendResult) { renderKodexModal(); }
    },
    kxBuildExport() {
      const st = kx();
      const info = { campaignId: ui.activeCampaignId, campaignName: ui.activeCampaignName, onlyChanged: st.onlyChanged };
      st.exportPreview = kxs().buildKuratorExport(campaign, info);
      const dflt = (key) => (st.focusId ? key === st.focusId : true);
      st.exportPreview.pkg.entities.forEach((e) => { if (!(e.kuratorId in st.sendSel)) st.sendSel[e.kuratorId] = dflt(e.kuratorId); });
      (st.exportPreview.pkg.dcChecks || []).forEach((d) => { if (!(('dc:' + d.kuratorId) in st.sendSel)) st.sendSel['dc:' + d.kuratorId] = dflt('dc:' + d.kuratorId); });
      renderKodexModal();
    },
    kxSendOnlyChanged(on) { const st = kx(); st.onlyChanged = !!on; window.app.kxBuildExport(); },
    kxSendSet(field, value) { const st = kx(); if (!st) return; st[field] = value; kxSendPaint(); },
    kxSendCollapse(id) { const st = kx(); if (!id) return; st.sendCollapsed[id] = !st.sendCollapsed[id]; kxSendPaint(); },
    kxSendSection(id, on) {
      const st = kx(); const sec = kxSendVisible().find((x) => x.id === id); if (!sec) return;
      sec.items.forEach((it) => { st.sendSel[it.key] = !!on; }); kxSendPaint();
    },
    // Click: toggle · Shift: range from the last clicked row · Ctrl/Cmd: only this one.
    kxSendClick(ev, key) {
      const st = kx(); if (!st) return;
      if (ev.ctrlKey || ev.metaKey) {
        kxSendItems().forEach((it) => { st.sendSel[it.key] = it.key === key; });
        st.sendAnchor = key;
      } else if (ev.shiftKey && st.sendAnchor && st.sendOrder.includes(st.sendAnchor) && st.sendOrder.includes(key)) {
        const a = st.sendOrder.indexOf(st.sendAnchor), b = st.sendOrder.indexOf(key);
        const state = st.sendRangeState !== undefined ? st.sendRangeState : !!st.sendSel[st.sendAnchor];
        st.sendOrder.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((k) => { st.sendSel[k] = state; });
      } else {
        st.sendSel[key] = !st.sendSel[key]; st.sendAnchor = key; st.sendRangeState = st.sendSel[key];
      }
      if (ev.ctrlKey || ev.metaKey) st.sendRangeState = true;
      if (ev.shiftKey) { try { window.getSelection().removeAllRanges(); } catch { /* ignore */ } }
      kxSendPaint();
    },
    kxSendBulk(what, on) {
      const st = kx(); if (!st) return;
      if (what === 'all') kxSendItems().forEach((it) => { st.sendSel[it.key] = false; });
      else kxSendVisible().forEach((sec) => sec.items.forEach((it) => { st.sendSel[it.key] = what === 'invert' ? !st.sendSel[it.key] : !!on; }));
      kxSendPaint();
    },
    kxSendToggle(id, on) { kx().sendSel[id] = !!on; kxSendPaint(); },
    kxSendAll(on) { kxSendItems().forEach((it) => { kx().sendSel[it.key] = !!on; }); kxSendPaint(); },
    async kxSend(how) {
      const st = kx();
      const ids = st.exportPreview.pkg.entities.filter((e) => st.sendSel[e.kuratorId]).map((e) => e.kuratorId);
      const checkIds = (st.exportPreview.pkg.dcChecks || []).filter((d) => st.sendSel['dc:' + d.kuratorId]).map((d) => d.kuratorId);
      if (!ids.length && !checkIds.length) return;
      const ex = kxs().buildKuratorExport(campaign, { campaignId: ui.activeCampaignId, campaignName: ui.activeCampaignName, onlyChanged: st.onlyChanged, entityIds: ids, checkIds });
      if (how === 'file') {
        const r = await window.core.kodexSaveExport(ui.activeCampaignName || 'kurator', JSON.stringify(ex.pkg, null, 2));
        st.sendResult = r && r.ok ? `Saved ${ex.pkg.entities.length} entities${(ex.pkg.dcChecks || []).length ? ` and ${ex.pkg.dcChecks.length} DC checks` : ''} to ${r.path}. Import it in Kodex; it will ask before applying. (They stay listed here as “changed” until Kodex sends them back.)` : (r && r.error ? `Could not save: ${r.error}` : '');
      } else {
        const r = await window.core.kodexPush(ex.pkg);
        if (r && r.ok) {
          // Only remember "transferred" once Kodex has really applied it (the user reviews there first).
          const id = r.result && r.result.importId;
          if (id) kxWatchPush(id, ex);
          else { ex.commit(r.result); await persistSafely(); }
          st.sendResult = `Sent ${ex.pkg.entities.length} entities${(ex.pkg.dcChecks || []).length ? ` and ${ex.pkg.dcChecks.length} DC checks` : ''}. Kodex shows its review screen${r.result && r.result.message ? `: ${r.result.message}` : '.'} They stay listed as changed until Kodex has applied them.`;
          renderKodexModal();
          return;
        }
        st.sendResult = `Not sent: ${(r && r.error) || 'unknown error'}`;
      }
      renderKodexModal();
    },
    // --- entity link ---
    async openInKodex(entityId) {
      const e = campaign.entities[entityId];
      const k = e && e.external && e.external.kodex;
      if (!k || !k.id) return;
      const r = await window.core.kodexOpenPage({ kodexId: k.id, kuratorId: e.id, workspace: k.workspace });
      if (!r || !r.ok) window.Health.notice((r && r.error) || 'Could not open Kodex.');
      else if (r.found === false) window.Health.notice(`Kodex has no page “${k.title || e.name}” any more. Use Change… to pick another one.`);
      else if (r.launched) window.Health.notice('Starting Kodex…');
    },
    setEntityFlag(entityId, field, value) {
      const e = campaign.entities[entityId]; if (!e) return;
      e[field] = !!value;
      persistSafely(); refresh();
    },
    async kxPickOpen(entityId) {
      const e = campaign.entities[entityId]; if (!e) return;
      ui.kodex = { mode: 'pick', entityId, q: e.name || '', type: kxTypeFor(e), results: [], loading: true, error: '', seq: 0, source: '', note: '', fellBack: false };
      kxOpenModal(); renderKodexModal();
      await kxPickRun();
      const qi = document.getElementById('kx-pick-q'); if (qi) { qi.focus(); qi.select(); }
    },
    kxPickQuery(v) {
      const st = kx(); if (!st) return;
      st.q = v; st.fellBack = false; clearTimeout(st.timer);
      st.timer = setTimeout(kxPickRun, 220);
    },
    kxPickType(v) { const st = kx(); if (!st) return; st.type = v; st.fellBack = false; kxPickRun(); },
    kxPickEnter() {
      const st = kx(); if (!st || !st.results.length) return;
      const e = campaign.entities[st.entityId];
      if (kxFold(st.results[0].name) === kxFold(e && e.name)) window.app.kxPickChoose(0);
    },
    kxPickChoose(i) {
      const st = kx(); const pg = st && st.results[i]; if (!pg) return;
      const e = campaign.entities[st.entityId]; if (!e) return;
      const old = e.external && e.external.kodex;
      const other = Object.values(campaign.entities).find((x) => x.id !== e.id && x.external && x.external.kodex && x.external.kodex.id === pg.id);
      if (other && !confirm(`“${pg.name}” is already linked to “${other.name}”. Link it to “${e.name}” as well?`)) return;
      if (old && old.id && old.id !== pg.id && old.importedAt && !confirm(`“${e.name}” was imported from another Kodex page. Changing the link starts the sync history for this entity from scratch. Continue?`)) return;
      if (!e.external || typeof e.external !== 'object') e.external = {};
      const same = old && old.id === pg.id;
      e.external.kodex = same ? Object.assign({}, old, { title: pg.name, type: pg.type, pathText: pg.pathText || '' }) : { id: pg.id, workspace: st.workspace || (old && old.workspace) || '', title: pg.name, type: pg.type, pathText: pg.pathText || '', map: {} };
      e.kodexAuto = true;
      window.app.closeKodex();
      persistSafely(); refresh();
    },
    unlinkKodex(entityId) {
      const e = campaign.entities[entityId];
      if (!e || !e.external || !e.external.kodex) return;
      if (!confirm(`Unlink “${e.name}” from Kodex? Nothing is deleted here or in Kodex; the next import will ask to link them again.`)) return;
      delete e.external.kodex;
      if (!Object.keys(e.external).length) delete e.external;
      refresh();
    }
  };
}

// Kodex type filter that fits an entity: encounter -> encounter, npc -> npc, location -> location.
function kxTypeFor(entity) {
  if (!entity) return '';
  if (entity.type === 'location' && entity.encounter) return 'encounter';
  return entity.type === 'npc' ? 'npc' : entity.type === 'location' ? 'location' : '';
}
const kxFold = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function kxLinkLine(k) {
  const bits = [k.title ? `<b>${esc(k.title)}</b>` : 'Linked page', k.type ? esc(k.type) : '', k.pathText ? esc(k.pathText) : ''].filter(Boolean);
  return `${bits.join(' · ')}${k.workspace ? ` <span class="hint">in “${esc(k.workspace)}”</span>` : ''}`;
}

// The Kodex row of the entity editor. Quests have no Kodex page of their own here (shown only if already linked).
function kodexEntityRowHTML(entity) {
  const k = entity.external && entity.external.kodex;
  const linked = !!(k && k.id);
  if (!linked && entity.type === 'quest') return '';
  if (!linked) {
    return `<div class="form-row"><label>Kodex</label><div class="inline"><span class="hint" style="flex:1">Not linked to a Kodex page.</span>
      <button class="icon-btn" onclick="window.app.kxPickOpen('${entity.id}')">Find in Kodex…</button></div></div>`;
  }
  return `<div class="form-row"><label>Kodex</label><div class="inline" style="flex-wrap:wrap">
    <label class="hint" style="display:flex;align-items:center;gap:5px;margin:0" title="Open this page in Kodex automatically when you open the entity in Play"><input type="checkbox" ${entity.kodexAuto ? 'checked' : ''} onchange="window.app.setEntityFlag('${entity.id}','kodexAuto',this.checked)"> Open in Play</label>
    <span style="flex:1;min-width:160px">${kxLinkLine(k)}</span>
    <button class="icon-btn" onclick="window.app.openInKodex('${entity.id}')">Open in Kodex</button>
    <button class="icon-btn" onclick="window.app.kxPickOpen('${entity.id}')">Change…</button>
    <button class="icon-btn" title="Remove the link only. Nothing is deleted." onclick="window.app.unlinkKodex('${entity.id}')">Unlink</button></div></div>`;
}

// Play: open the linked Kodex page together with the entity (only when its checkbox is on). Link without stealing focus.
function maybeOpenKodex(entityId) {
  const e = campaign.entities[entityId];
  const k = e && e.external && e.external.kodex;
  if (!e || !k || !k.id || !e.kodexAuto) return;
  window.core.kodexOpenPage({ kodexId: k.id, kuratorId: e.id, workspace: k.workspace, focus: false, viaLink: true }).then((r) => {
    if (!r || !r.ok) console.warn('[kodex] could not open page for', e.name, '-', r && r.error);
  });
}

// --- picker ---
function kxPickHTML() {
  const st = kx(); const e = campaign.entities[st.entityId];
  const types = [['npc', 'NPCs'], ['location', 'Locations'], ['encounter', 'Encounters'], ['', 'All pages']];
  return `<p class="hint">Pick the Kodex page for <b>${esc(e ? e.name || 'this entity' : '')}</b>. The name is searched first.</p>
    <div class="inline" style="margin-bottom:8px">
      <input type="text" id="kx-pick-q" value="${esc(st.q)}" placeholder="Search name, place or type" style="flex:1" oninput="window.app.kxPickQuery(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();window.app.kxPickEnter();}">
      <select id="kx-pick-type" onchange="window.app.kxPickType(this.value)">${types.map(([v, l]) => `<option value="${v}" ${v === st.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div id="kx-pick-note" class="hint" style="margin-bottom:6px"></div>
    <div id="kx-pick-results" class="kx-left" style="max-height:46vh"></div>`;
}
function kxPickResultsHTML() {
  const st = kx(); const e = campaign.entities[st.entityId];
  if (st.loading) return '<p class="empty-hint">Searching…</p>';
  if (st.error) return `<p class="empty-hint">${esc(st.error)}</p>`;
  if (!st.results.length) return '<p class="empty-hint">No pages found.</p>';
  const nameKey = kxFold(e && e.name);
  return st.results.map((pg, i) => {
    const best = i === 0 && nameKey && kxFold(pg.name) === nameKey;
    const other = Object.values(campaign.entities).find((x) => x.id !== st.entityId && x.external && x.external.kodex && x.external.kodex.id === pg.id);
    const where = pg.pathText || ((pg.path || []).length ? pg.path[pg.path.length - 1].name : '');
    return `<div class="kx-row" style="cursor:pointer;display:flex;gap:8px;align-items:center;padding:6px 8px" onclick="window.app.kxPickChoose(${i})">
      <span>${pg.icon ? esc(pg.icon) : ''}</span><b>${esc(pg.name)}</b><span class="hint">${esc(pg.type || '')}${where ? ` · ${esc(where)}` : ''}</span>
      ${best ? '<span class="kx-badge kx-new">Best match</span>' : ''}${other ? `<span class="kx-badge kx-conflict" title="Already linked to another entity">linked to ${esc(other.name)}</span>` : ''}</div>`;
  }).join('');
}
function kxPickPaint() {
  const st = kx(); if (!st || st.mode !== 'pick') return;
  const r = document.getElementById('kx-pick-results'); if (r) r.innerHTML = kxPickResultsHTML();
  const n = document.getElementById('kx-pick-note');
  if (n) n.textContent = st.note || (st.source === 'live' ? 'Live from the running Kodex.' : st.source === 'file' ? 'Read from the Kodex workspace folder (Kodex is closed).' : '');
}
async function kxPickRun() {
  const st = kx(); if (!st || st.mode !== 'pick') return;
  const seq = ++st.seq; st.loading = true; st.error = ''; kxPickPaint();
  let r;
  try { r = await window.core.kodexPages(st.q, st.type, 200); } catch (err) { r = { ok: false, error: err.message }; }
  if (!kx() || kx().mode !== 'pick' || seq !== st.seq) return;
  st.loading = false; st.note = '';
  if (!r || !r.ok) { st.error = (r && r.error) || 'Could not read Kodex pages.'; st.results = []; kxPickPaint(); return; }
  st.source = r.source; st.workspace = r.workspace || ''; st.results = r.pages || [];
  if (!st.results.length && st.q && !st.fellBack) { // nothing under that name: show the whole filtered list instead
    st.fellBack = true; st.q = ''; const qi = document.getElementById('kx-pick-q'); if (qi) qi.value = '';
    await kxPickRun(); if (kx() && kx().mode === 'pick') { kx().note = 'No page with that name. Showing all of this type.'; kxPickPaint(); }
    return;
  }
  kxPickPaint();
}

// Called once from init(): receives pushed packages, inbox changes and "open this entity" requests.
function kodexInit() {
  if (!window.core.onKodexIncoming) return;
  window.core.onKodexIncoming(async (p) => {
    if (!p) return;
    if (p.source === 'open') { if (campaign.entities[p.entityId]) { ui.fullPageEntityId = p.entityId; renderAll(); } return; }
    await kxStart(p.pkg, p.name, { importId: p.importId });
  });
  window.core.onKodexInbox((items) => {
    if (ui.kodex && ui.kodex.mode === 'home') { ui.kodex.inbox = items; renderKodexModal(); }
    kxUpdateBadge(items);
  });
  window.core.kodexInboxList().then(kxUpdateBadge).catch(() => {});
  window.core.kodexReady();
}

function kxUpdateBadge(items) {
  ui.kodexWaiting = (items || []).length;
  const b = document.getElementById('kodex-open-btn');
  if (b) b.innerHTML = kodexButtonInner();
}
function kodexButtonInner() { return `${icon('chevronRight')} Kodex${ui.kodexWaiting ? ` <span class="kx-badge kx-new">${ui.kodexWaiting}</span>` : ''}`; }

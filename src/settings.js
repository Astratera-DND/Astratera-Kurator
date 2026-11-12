// Machine-level app settings — separate from campaign-data/, since these
// apply across every campaign rather than belonging to one of them.
// The path to the local Notion.exe (used to open an entity's Notion link
// in the desktop app instead of a browser tab), and the two paths the
// Director-tool integration needs: the session-prep root (where
// sessions/scenes/layouts live on disk, for browsing them from the
// entity editor) and the Director app's own folder (where its
// command-watcher patch — see check_remote_command() in that project —
// looks for director_remote_command.json). Plain JSON, sits at the
// project root, safe to hand-edit any of these directly if a path ever
// changes (a reinstall, a different machine, etc).

const fs = require('fs');
const path = require('path');

// Notion's default Windows install location, built from the current user's own
// profile. Elsewhere (or if Notion lives somewhere else) it can be edited in
// settings.json.
const DEFAULT_NOTION_EXE_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
  'Programs', 'Notion', 'Notion.exe'
);

function settingsFile(baseDir) {
  return path.join(baseDir, 'settings.json');
}

function defaultSettings() {
  return {
    notionExePath: DEFAULT_NOTION_EXE_PATH,
    directorPrepRootPath: '',
    directorAppFolderPath: '',
    // The folder the last entity image was picked from, so the next image
    // dialog opens right there. Machine-level on purpose: where a person
    // keeps their images has nothing to do with which campaign is open.
    lastImageDirectory: '',
    // Folder of default artwork. A new NPC/location whose name matches a file
    // in here (loosely: MiraSelven.png, mira-selven.jpg…) is offered that image.
    artworkFolderPath: '',
    // Kodex connection: the folder Kodex drops export packages into (watched), and the
    // inbox items already dealt with (name:mtime), so a package is offered only once.
    kodexInboxPath: '',
    kodexInboxSeen: [],
    // Workspace folder Kodex last reported (its discovery file is gone while Kodex is closed). Used to list pages by file.
    kodexWorkspaceDir: '',
    // Last window position and size ({ x, y, width, height, maximized }), restored on the next start.
    windowBounds: null
  };
}

function loadSettings(baseDir) {
  const file = settingsFile(baseDir);
  if (!fs.existsSync(file)) {
    const defaults = defaultSettings();
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Backfill any settings added after this file was first created, same
    // reasoning as normalizeCampaign in storage.js — an existing
    // settings.json should never end up missing a field newer code
    // expects, without every read site needing to defensively check.
    // Object.assign here (defaults first, parsed second) means an
    // existing value always wins over a default, and only a genuinely
    // absent key gets backfilled.
    return Object.assign(defaultSettings(), parsed);
  } catch {
    return defaultSettings();
  }
}

function saveSettings(baseDir, settings) {
  fs.writeFileSync(settingsFile(baseDir), JSON.stringify(settings, null, 2), 'utf8');
}

// A remembered folder is only worth handing to a file dialog if it is
// still there — a deleted folder or an unplugged drive would otherwise
// leave the dialog with a bad starting point. Anything unusable comes back
// undefined, which makes the dialog fall back to the operating system's
// own default, exactly as if nothing had been remembered.
function usableDirectory(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return undefined;
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

// Remembers the folder a file was just picked from. Returns the settings
// to keep using — the same object when the folder is unchanged (no needless
// write), otherwise an updated copy that has also been saved. Saving is a
// convenience: if writing settings.json fails (read-only folder, say), the
// folder is still remembered for this session and picking the image carries
// on undisturbed rather than failing over a bookkeeping detail.
function rememberLastImageDirectory(baseDir, settings, pickedFilePath) {
  const dir = path.dirname(pickedFilePath);
  if (!dir || settings.lastImageDirectory === dir) return settings;
  const updated = Object.assign({}, settings, { lastImageDirectory: dir });
  try {
    saveSettings(baseDir, updated);
  } catch {
    // intentionally ignored — see above
  }
  return updated;
}

module.exports = { usableWindowBounds, loadSettings, saveSettings, settingsFile, usableDirectory, rememberLastImageDirectory, DEFAULT_NOTION_EXE_PATH };

// A saved window rectangle is only used when it still lies (mostly) on a screen that exists now:
// a monitor may have been unplugged since. `displays` = [{ x, y, width, height }] work areas.
function usableWindowBounds(saved, displays) {
  if (!saved || typeof saved !== 'object') return null;
  const w = Math.round(Number(saved.width)), h = Math.round(Number(saved.height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 300 || h < 300) return null;
  const out = { width: w, height: h, maximized: saved.maximized === true };
  const x = Number(saved.x), y = Number(saved.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const visible = (displays || []).some((d) => {
      const ox = Math.min(x + w, d.x + d.width) - Math.max(x, d.x);
      const oy = Math.min(y + h, d.y + d.height) - Math.max(y, d.y);
      return ox >= 120 && oy >= 80;
    });
    if (visible) { out.x = Math.round(x); out.y = Math.round(y); }
  }
  return out;
}

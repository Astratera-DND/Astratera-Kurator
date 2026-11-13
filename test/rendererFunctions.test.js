// Guards against a renderer function being lost in an edit (the Kodex import review once vanished that way):
// every kx* / enc* helper that is called must be defined somewhere in the renderer scripts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function test(name, fn) { try { fn(); console.log(`ok  - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.stack}`); } }

const dir = path.join(__dirname, '..', 'renderer');
const files = ['app.js', 'kodexView.js', 'encountersView.js', 'questsView.js', 'conditionsView.js'].filter((f) => fs.existsSync(path.join(dir, f)));
const src = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('every called kx*/enc*/kodex* helper is defined', () => {
  const called = new Set((src.match(/(?<![.\w])(?:kx|enc|kodex)[A-Z]\w*(?=\()/g) || []));
  const defined = (n) => new RegExp(`(function\\s+${n}\\b|(?:const|let|var)\\s+${n}\\b|^\\s+(?:async\\s+)?${n}\\s*\\()`, 'm').test(src);
  const missing = [...called].filter((n) => !defined(n));
  assert.deepStrictEqual(missing, []);
});

test('the import review and report screens exist', () => {
  ['kxReviewHTML', 'kxEntityDetailHTML', 'kxCollectionDetailHTML', 'kxReportHTML', 'kxHomeHTML', 'kxSendHTML', 'kxPickHTML'].forEach((n) => assert.ok(new RegExp(`function ${n}\\b`).test(src), n));
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }

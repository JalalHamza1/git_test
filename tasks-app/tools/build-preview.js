// Builds dist/preview.html: index.html with styles.html and app.html inlined, so the app
// opens straight in a browser with sample data (preview mode). Usage: node tools/build-preview.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
// preview.html loads the editor from the CDN like Apps Script does (QUILL_LOADER in Code.gs);
// preview-local.html inlines optional/quill.html, so it works offline (used by the tests).
const vm = require('vm');
const ctx = { HtmlService: {} };
vm.createContext(ctx);
vm.runInContext(read('Code.gs') + '\n;globalThis.__loader = QUILL_LOADER;', ctx);
const build = quill => read('index.html')
  .replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => read(name + '.html'))
  .replace(/<\?!=\s*quillScript\(\);?\s*\?>/g, () => quill);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'preview.html'), build(ctx.__loader));
fs.writeFileSync(path.join(root, 'dist', 'preview-local.html'), build(read('optional/quill.html')));
console.log('Wrote dist/preview.html (editor from the CDN) and dist/preview-local.html (offline editor)');

// Builds dist/preview.html: index.html with styles.html and app.html inlined, so the app
// opens straight in a browser with sample data (preview mode). Usage: node tools/build-preview.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html').replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => read(name + '.html'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'preview.html'), html);
console.log('Wrote dist/preview.html');

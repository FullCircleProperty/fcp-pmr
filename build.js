#!/usr/bin/env node
// Build: Assemble frontend parts → inline into worker → dist/worker.js
const fs = require('fs');
const path = require('path');

const partsDir = path.join(__dirname, 'frontend', 'parts');
const jsDir = path.join(partsDir, 'js');
const workerSrc = path.join(__dirname, 'src', 'worker.js');
const distDir = path.join(__dirname, 'dist');
const distFile = path.join(distDir, 'worker.js');

// Read parts
const css = fs.readFileSync(path.join(partsDir, 'styles.css'), 'utf8');
const authHtml = fs.readFileSync(path.join(partsDir, 'auth-screens.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(partsDir, 'app-html.html'), 'utf8');

// Assemble JS from split files (sorted alphabetically by filename)
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();
const js = jsFiles.map(f => {
  const content = fs.readFileSync(path.join(jsDir, f), 'utf8');
  return '// ── ' + f + ' ──\n' + content;
}).join('\n');
console.log('  JS parts: ' + jsFiles.join(', ') + ' (' + jsFiles.length + ' files)');

// Assemble full HTML
const fullHtml = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">\n' +
'<meta name="apple-mobile-web-app-capable" content="yes">\n' +
'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
'<meta name="theme-color" content="#0f1117">\n' +
'<link rel="manifest" href="/manifest.json">\n' +
'<title>FCP — Property Market Research</title>\n' +
'<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">\n' +
'<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.css">\n' +
'<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/themes/dark.min.css">\n' +
'<script src="https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.js"><\/script>\n' +
'<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
authHtml + '\n' + appHtml + '\n<script>\n' + js + '\n</script>\n</body>\n</html>';

// Also write assembled HTML for preview
fs.writeFileSync(path.join(__dirname, 'frontend', 'index.html'), fullHtml, 'utf8');

// Minify frontend before embedding - only safe whitespace reduction, NO comment stripping
// Comment stripping with regex is unsafe — breaks URLs (https://), regex patterns, and template literals
const minFrontend = fullHtml
  .replace(/\n\s*\n\s*\n/g, '\n') // collapse 3+ consecutive newlines to 1
  .replace(/\n {4,}/g, '\n') // strip excessive leading indentation (keep 0-3 spaces)
  .replace(/\n{3,}/g, '\n\n'); // cap at 2 consecutive newlines

// Inline into worker
let worker = fs.readFileSync(workerSrc, 'utf8');
// No comment stripping on worker — regex-based stripping breaks template literals containing // or /* patterns
const jsonStr = JSON.stringify(minFrontend);
worker = worker.replace('"__FRONTEND_PLACEHOLDER__"', () => jsonStr);

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(distFile, worker, 'utf8');

const kb = Math.round(fs.statSync(distFile).size / 1024);
console.log('✅ Assembled frontend (' + Math.round(fullHtml.length / 1024) + ' KB → ' + Math.round(minFrontend.length / 1024) + ' KB minified)');
console.log('✅ Built dist/worker.js (' + kb + ' KB)');
if (kb > 1024) console.log('⚠️  Over 1MB — requires Workers Paid plan ($5/mo)');
else console.log('  ✓ Under 1MB free tier limit');

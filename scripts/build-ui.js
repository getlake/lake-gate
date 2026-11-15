#!/usr/bin/env node
// Builds the static review UI for GitHub Pages: ui/ + browser-safe core modules -> landing/app/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_FILES } from '../src/ui-server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'landing', 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'ui'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'core'), { recursive: true });
for (const f of CORE_FILES) fs.copyFileSync(path.join(root, 'src', f), path.join(out, 'core', f));
const idx = path.join(out, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<!--LAKE_KEY-->\n', ''));
console.log(`Built ${path.relative(root, out)} (${fs.readdirSync(out).length} entries)`);

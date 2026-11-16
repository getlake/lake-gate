// Release guards: the browser bundle has every module it imports, and the CLI ships ui + mcp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CORE_FILES } from '../src/ui-server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_ONLY = /from 'node:/;

test('every module the browser loads from core/ is in CORE_FILES and is browser-safe', () => {
  const seen = new Set(); const queue = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'ui')).filter((x) => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8').matchAll(/from '\.\/core\/([\w-]+\.js)'/g)) queue.push(m[1]);
  }
  while (queue.length) {
    const f = queue.pop(); if (seen.has(f)) continue; seen.add(f);
    assert.ok(CORE_FILES.includes(f), `${f} is imported by the browser but missing from CORE_FILES`);
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    assert.doesNotMatch(src, NODE_ONLY, `${f} imports a Node built-in`);
    for (const m of src.matchAll(/from '\.\/([\w-]+\.js)'/g)) queue.push(m[1]);
  }
});

test('the CLI lists ui and mcp, and the package ships them', () => {
  const r = spawnSync('node', [path.join(ROOT, 'bin/lake-gate.js'), '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /lake-gate ui\b/); assert.match(r.stdout, /lake-gate mcp\b/); assert.match(r.stdout, /init \[--try\]/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of ['ui', 'src']) assert.ok(pkg.files.includes(f));
  assert.ok(fs.existsSync(path.join(ROOT, 'src/mcp.js')) && fs.existsSync(path.join(ROOT, 'src/ui-server.js')));
});

test('shared estimator is in sync with lake-meter when both checkouts are present', () => {
  const meter = path.join(ROOT, '..', 'exp-a-meter', 'src', 'prices.json');
  if (!fs.existsSync(meter)) return;
  const src = fs.readFileSync(path.join(ROOT, 'src/meter-core.js'), 'utf8');
  const m = src.match(/export const PRICES = (\{[\s\S]*?\n\});/);
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(fs.readFileSync(meter, 'utf8')), 'run node scripts/sync-meter.mjs ../exp-a-meter');
});

test('MCP Registry metadata matches the package', async () => {
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const srv = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  assert.equal(pkg.mcpName, 'io.github.getlake/lake-gate');
  assert.equal(srv.name, pkg.mcpName);
  assert.equal(srv.version, pkg.version);
  assert.equal(srv.packages[0].version, pkg.version);
  assert.equal(srv.packages[0].identifier, pkg.name);
  assert.ok(srv.description.length <= 100);
});

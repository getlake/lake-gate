// MCP server, local UI server, init wiring, and the UI's own modules (markdown + demo data through the real data layer).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpRepo } from './helpers.js';
import { exportPlan, loadPlan } from '../src/store.js';
import { renderPlanFile } from '../src/plan.js';
import { client } from '../src/github.js';
import { createContext, callTool, TOOLS } from '../src/mcp.js';
import { createUiServer } from '../src/ui-server.js';
import { init } from '../src/init.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BODY = '# Retries\n\n## Steps\n1. Retry 6 times with exponential backoff\n2. Store the payload\n3. Add tests for backoff\n';
const FILE = renderPlanFile({ id: 'retries', title: 'Retries', author: 'maya', body: BODY, estimateMd: 'x' });

function fakePr() {
  const comments = []; const calls = [];
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
  const pr = { number: 9, user: { login: 'maya' }, head: { sha: 'h1', ref: 'b' }, base: { sha: 'base' }, state: 'open', html_url: 'u', requested_reviewers: [] };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/acme/app', ''); const m = opts.method; const page = Number(u.searchParams.get('page') || 1);
    calls.push({ m, p, body: opts.body ? JSON.parse(opts.body) : null });
    const list = (a) => json(page === 1 ? a : []);
    if (p === '/pulls/9') return json(pr);
    if (p === '/pulls/9/files') return list([{ filename: '.lake/plans/retries.md', status: 'added' }]);
    if (p === '/pulls/9/commits') return list([{ sha: 'h1', commit: { committer: { date: '2026-11-12T10:00:00Z' } } }]);
    if (p === '/issues/9/comments' && m === 'GET') return list(comments);
    if (p === '/pulls/9/reviews' || p === '/pulls/9/comments') return list([]);
    if (p === '/commits') return json([{ sha: 'h1' }]);
    if (p.startsWith('/contents/')) return p.includes('config') ? json({}, 404) : json({ content: Buffer.from(FILE).toString('base64') });
    if (m === 'POST' && p === '/issues/9/comments') { const c = { id: comments.length + 1, user: { login: 'noah', type: 'User' }, author_association: 'MEMBER', body: JSON.parse(opts.body).body, created_at: new Date(Date.now() + comments.length * 1000).toISOString() }; comments.push(c); return json(c, 201); }
    if (m === 'POST') return json({}, 201);
    return json({ message: 'unexpected ' + p }, 404);
  };
  return { fetchImpl, comments, calls };
}

test('MCP tools: status with threads, wait for feedback, version-checked approve, revision resolves threads', async () => {
  const repo = tmpRepo();
  exportPlan(repo, BODY, { id: 'retries' });
  const f = fakePr();
  const gh = client({ token: 't', repo: 'acme/app', fetchImpl: f.fetchImpl });
  const short = loadPlan(repo, 'retries').short;
  let sleeps = 0;
  const ctx = createContext({ root: repo, gh, prNumber: 9, clientName: 'Claude Code', sleep: async () => {
    sleeps++;
    if (sleeps === 2) f.comments.push({ id: 50, user: { login: 'leo', type: 'User' }, author_association: 'MEMBER', created_at: '2026-11-12T11:00:00Z',
      body: `**Comment on \`retries\`**\nWhy 6?\n<!-- lake:c {"p":"retries","v":"${short}","t":"t9","a":{"s":4,"e":4,"q":"1. Retry 6 times"}} -->` });
  } });
  assert.ok(TOOLS.every((t) => t.name.startsWith('lake_') && t.inputSchema.type === 'object'));
  let out = await callTool(ctx, 'lake_review_status', {});
  assert.match(out, new RegExp(`Plan retries · v${short} \\(round 1\\) · status: in-review`));
  assert.match(out, /  4\| 1\. Retry 6 times/);
  out = await callTool(ctx, 'lake_review_status', { wait_seconds: 120 });
  assert.match(out, /^Changed after 40s/);
  assert.match(out, /\[t9\] round 1, "Steps", line 4 on: "1\. Retry 6 times"/);
  assert.match(out, /@leo: Why 6\?/);

  out = await callTool(ctx, 'lake_approve', { plan_id: 'retries', version: 'deadbeef' });
  assert.match(out, /^Not posted: version deadbeef is not the current version/);
  assert.match(await callTool(ctx, 'lake_request_changes', { plan_id: 'retries', version: short, comment: ' ' }), /^Not posted/);
  out = await callTool(ctx, 'lake_approve', { plan_id: 'retries', version: short, comment: 'Go' });
  assert.match(out, /^Approved retries v/);
  assert.match(f.comments.at(-1).body, new RegExp(`^/lake approve retries@${short}`));
  assert.match(f.comments.at(-1).body, /Claude Code \(MCP\)/);
  out = await callTool(ctx, 'lake_review_status', {});
  assert.match(out, /status: approved/);
  assert.match(out, /@noah approved via Claude Code \(MCP\): Go/);
  const approvals = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'lake', 'approvals.json'), 'utf8'));
  assert.equal(approvals.retries.state, 'approved', 'status syncs approvals locally so the hook opens');

  await callTool(ctx, 'lake_reply', { thread_id: 't9', text: 'Matches the SLA', plan_id: 'retries' });
  assert.match(f.comments.at(-1).body, /lake:c \{"p":"retries","t":"t9","re":1\}/);
  out = await callTool(ctx, 'lake_submit_revision', { plan_markdown: BODY.replace('6 times', '5 times'), plan_id: 'retries', addressed_threads: ['t9'], note: 'Down to 5' });
  assert.match(out, /^Saved retries v/);
  assert.notEqual(loadPlan(repo, 'retries').short, short);
  assert.match(f.comments.at(-1).body, /lake:resolve \{"p":"retries","t":"t9","r":true\}/);
  out = await callTool(ctx, 'lake_review_status', {});
  assert.match(out, /your local plan file is a different version/);
});

test('MCP server speaks JSON-RPC over stdio', async () => {
  const child = spawn('node', [path.join(ROOT, 'bin/lake-gate.js'), 'mcp'], { cwd: tmpRepo(), stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' }, capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lake_review_status', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'nope' });
  for (let i = 0; i < 50 && lines.length < 4; i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const by = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(by[1].result.serverInfo.name, 'lake-gate');
  assert.ok(by[2].result.tools.some((t) => t.name === 'lake_approve'));
  assert.equal(by[3].result.isError, true);
  assert.match(by[3].result.content[0].text, /No plan id given and no active plan|No GitHub remote/);
  assert.equal(by[4].error.code, -32601);
});

test('local UI server: per-run key, narrow GitHub proxy holding the token, safe static files, local plan history', async () => {
  const repo = tmpRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: repo });
  exportPlan(repo, BODY, { id: 'retries' });
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'plan'], { cwd: repo });
  fs.appendFileSync(path.join(repo, '.lake/plans/retries.md'), '\n4. Add metrics\n');
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { status: 200, text: async () => '[]' }; };
  const { server, key } = createUiServer({ root: repo, token: 'secret-token', fetchImpl, key: 'k1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, o = {}) => fetch(base + p, o);
  const H = { 'X-Lake-Key': key };
  try {
    const html = await (await get('/')).text();
    assert.match(html, /<meta name="lake-key" content="k1">/);
    assert.doesNotMatch(html, /secret-token/);
    assert.equal((await get('/api/env')).status, 403);
    const env = await (await get('/api/env', { headers: H })).json();
    assert.deepEqual([env.repo, env.hasToken], ['acme/app', true]);
    assert.equal((await get('/core/review.js')).status, 200);
    assert.equal((await get('/core/cli.js')).status, 404);
    assert.equal((await get('/..%2fsrc%2fcli.js')).status, 404);
    assert.equal((await get('/gh/repos/other/repo/pulls', { headers: H })).status, 403);
    assert.equal((await get('/gh/repos/acme/app/statuses/abc', { method: 'POST', headers: H, body: '{}' })).status, 403);
    assert.equal((await get('/gh/repos/acme/app/pulls?state=all', { headers: H })).status, 200);
    assert.equal(seen[0].url, 'https://api.github.com/repos/acme/app/pulls?state=all');
    assert.equal(seen[0].opts.headers.Authorization, 'Bearer secret-token');
    assert.equal((await get('/gh/repos/acme/app/issues/9/comments', { method: 'POST', headers: H, body: '{"body":"x"}' })).status, 200);
    assert.equal(seen[1].opts.body, '{"body":"x"}');
    const local = await (await get('/api/local', { headers: H })).json();
    assert.equal(local.plans[0].id, 'retries');
    assert.equal(local.plans[0].snapshots.length, 2, 'one commit plus the edited working tree');
  } finally { server.close(); }
});

test('init registers the MCP server for Claude Code and Cursor, idempotently, keeping other servers', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  init(repo);
  const a = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(a.mcpServers).sort(), ['lake-gate', 'other']);
  assert.deepEqual(a.mcpServers['lake-gate'].args, ['-y', 'lake-gate@0', 'mcp']);
  assert.ok(fs.existsSync(path.join(repo, '.cursor/mcp.json')));
  assert.ok(init(repo).some((l) => /kept {3}\.mcp\.json/.test(l)));
});

test('UI modules: markdown keeps line numbers; the demo workspace builds through the real data layer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-ui-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'ui')).filter((x) => x.endsWith('.js'))) fs.copyFileSync(path.join(ROOT, 'ui', f), path.join(dir, f));
  fs.symlinkSync(path.join(ROOT, 'src'), path.join(dir, 'core'));
  const md = await import(path.join(dir, 'md.js'));
  const blocks = md.parseBlocks('# T\n\nIntro line\nmore\n\n## Steps\n1. One\n   continued\n2. Two\n\n```\ncode\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.deepEqual(blocks.map((b) => [b.type, b.start, b.end]), [['heading', 1, 1], ['p', 3, 4], ['heading', 6, 6], ['list', 7, 9], ['code', 11, 13], ['table', 14, 16]]);
  assert.deepEqual(blocks[3].items.map((i) => [i.start, i.end, i.text]), [[7, 8, 'One continued'], [9, 9, 'Two']]);
  assert.equal(md.inline('<b>x</b> `a<b` **y**'), '&lt;b&gt;x&lt;/b&gt; <code>a&lt;b</code> <strong>y</strong>');
  assert.equal(md.inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))', 'only http(s) links become anchors');
  const demo = await import(path.join(dir, 'demo.js'));
  const ws = demo.demoWorkspace();
  const by = Object.fromEntries(ws.plans.map((p) => [p.id, p]));
  assert.equal(by['add-webhook-retries'].round, 3);
  assert.equal(by['add-webhook-retries'].status, 'in-review');
  assert.deepEqual(by['add-webhook-retries'].policy.approvers, ['leo'], 'native GitHub review on the v3 commit counts');
  assert.equal(by['safer-csv-exports'].status, 'changes-requested');
  assert.equal(by['cursor-pagination'].status, 'approved');
  assert.equal(by['rotate-api-keys'].status, 'draft');
  assert.ok(ws.plans.every((p) => p.threads.every((t) => t.anchor === null || t.anchor.start >= 1)));
  const people = JSON.stringify(demo.PEOPLE).toLowerCase();
  assert.ok(!/elad|tribal/.test(people + JSON.stringify(ws.plans).toLowerCase()), 'demo stays fictional');
  demo.demoPost(412, '/lake approve add-webhook-retries@' + by['add-webhook-retries'].short);
  assert.equal(demo.demoWorkspace().plans.find((p) => p.id === 'add-webhook-retries').status, 'approved');
});

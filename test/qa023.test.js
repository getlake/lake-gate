// Regression tests for QA's pass on 0.2.3 (G-12, G-14, G-17 … G-20, N-01) and the auto-approve reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleClaudePreToolUse } from '../src/hook.js';
import { exportPlan } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { init, upgradeWorkflow } from '../src/init.js';
import { client, evaluatePr, renderSummary, RateLimitError } from '../src/github.js';
import { loadWorkspace } from '../src/workspace.js';
import { createContext, callTool, formatReview } from '../src/mcp.js';
import { main } from '../src/cli.js';
import { readPlanText } from '../src/plan.js';
import { tmpRepo, fakeGitHub, comment, PLAN } from './helpers.js';

const git = (root, ...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
const PLAN_FILE = '.lake/plans/add-webhook-retries.md';
function planText() { const r = tmpRepo(); exportPlan(r, PLAN, { source: 'cli' }); return fs.readFileSync(path.join(r, PLAN_FILE), 'utf8'); }
const BROKEN = '{ "requiredApprovals": 1 "budget": {} }';

test('G-19 a broken policy on main keeps the last valid policy (never the looser default)', async () => {
  const text = planText(); const short = readPlanText(text).short;
  const comments = [comment('lee', `/lake approve add-webhook-retries@${short}`, '2026-11-12T08:00:00Z')];
  const strict = '{"requiredApprovals":2,"budget":{"approverAbove":1,"approvers":["dana"]}}';
  const gh = fakeGitHub({ files: [PLAN_FILE], contents: { [PLAN_FILE]: text }, comments, baseConfig: BROKEN, configHistory: { ['b'.repeat(40)]: BROKEN, ['a'.repeat(40)]: strict } });
  const ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.config.requiredApprovals, 2);
  assert.equal(ev.state, 'failure', 'one approval is not enough under the last valid policy');
  assert.match(ev.description, /^\.lake\/config\.json broken, last valid policy kept/);
  assert.match(renderSummary(ev), /Warning:.*not valid JSON \(line 1, column \d+\).*keeps the last valid policy \(main at aaaaaaa\)/);
});

test('G-19 no valid policy in history: the check fails closed with a clear message', async () => {
  const gh = fakeGitHub({ files: ['.lake/plans/x.md'], contents: { '.lake/plans/x.md': '# X\n\n1. Fix typo in README\n' }, baseConfig: BROKEN });
  const ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'failure');
  assert.match(ev.description, /^Policy file unreadable: fix \.lake\/config\.json on main \(line 1, column \d+\)$/);
  assert.equal(ev.results[0].state, 'pending', 'a tiny plan is not auto-approved under the strict fallback');
});

test('G-19 / N-01 locally: a broken working-tree policy keeps the committed one; the hook and status say so', async () => {
  const root = tmpRepo(); init(root, {});
  fs.writeFileSync(path.join(root, '.lake/config.json'), '{"requiredApprovals":2,"autoApprove":{"mode":"off"}}');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'lake');
  fs.writeFileSync(path.join(root, '.lake/config.json'), BROKEN);
  const c = loadConfig(root);
  assert.equal(c.requiredApprovals, 2); assert.equal(c.autoApprove.mode, 'off'); assert.match(c.policyFrom, /^commit /);
  for (const sid of ['a', 'a']) { // every call, not once per session
    const r = handleClaudePreToolUse({ cwd: root, session_id: sid, tool_name: 'Bash', tool_input: { command: 'git status' } }, {});
    assert.match(r.systemMessage, /not valid JSON.*last valid policy/);
  }
  exportPlan(root, PLAN, { source: 'cli' });
  const err = []; const here = process.cwd(); process.chdir(root);
  try { await main(['status'], { out: () => {}, err: (l) => err.push(l) }); } finally { process.chdir(here); }
  assert.match(err.join('\n'), /Warning: .*not valid JSON/);
  const fresh = tmpRepo(); fs.mkdirSync(path.join(fresh, '.lake')); fs.writeFileSync(path.join(fresh, '.lake/config.json'), BROKEN);
  const f = loadConfig(fresh);
  assert.equal(f.autoApprove.mode, 'off', 'no history: strict fallback, nothing auto-approves');
  assert.ok(f.policyBroken);
});

test('G-17 init upgrades an existing workflow and never resets the policy, even with --force', () => {
  const root = tmpRepo(); init(root, {});
  const wf = path.join(root, '.github/workflows/lake-gate.yml');
  const old = fs.readFileSync(wf, 'utf8').replace(/  push:.*\n.*\n/, '');
  assert.ok(!/push:/.test(old));
  fs.writeFileSync(wf, old);
  const policy = '{\n  "requiredApprovals": 2,\n  "budget": { "approverAbove": 5, "approvers": ["getlake"] }\n}\n';
  fs.writeFileSync(path.join(root, '.lake/config.json'), policy);
  const done = init(root, {});
  assert.ok(done.some((l) => /updated \.github\/workflows\/lake-gate\.yml \(added the push trigger/.test(l)), done.join('\n'));
  assert.match(fs.readFileSync(wf, 'utf8'), /push: .*\n    paths: \['\.lake\/config\.json'\]/);
  assert.ok(init(root, {}).some((l) => /kept   \.github\/workflows\/lake-gate\.yml \(up to date\)/.test(l)), 'idempotent');
  const forced = init(root, { force: true });
  assert.equal(fs.readFileSync(path.join(root, '.lake/config.json'), 'utf8'), policy);
  assert.ok(forced.some((l) => /kept   \.lake\/config\.json \(your policy/.test(l)));
  assert.match(fs.readFileSync(wf, 'utf8'), /push:/);
  assert.equal(upgradeWorkflow('name: other\non: push\n').changed, false);
});

test('G-18 the client caches commit-pinned reads, revalidates with ETags, and explains rate limits', async () => {
  const sha = 'c'.repeat(40); let n = 0; const seen = [];
  const fetchImpl = async (url, o) => {
    n++; seen.push(o.headers['If-None-Match'] || null);
    if (url.includes('/limited')) return { ok: false, status: 403, headers: new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', '1800000000']]), text: async () => '{"message":"API rate limit exceeded for 1.2.3.4."}' };
    if (o.headers['If-None-Match'] === '"e1"') return { ok: false, status: 304, headers: new Map(), text: async () => '' };
    return { ok: true, status: 200, headers: new Map([['etag', '"e1"']]), json: async () => ({ content: Buffer.from('hi').toString('base64') }) };
  };
  const store = new Map();
  const gh = client({ token: 't', repo: 'acme/app', fetchImpl, cache: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } });
  assert.equal(await gh.file('a.md', sha), 'hi'); assert.equal(await gh.file('a.md', sha), 'hi');
  assert.equal(n, 1, 'commit-pinned content is read once');
  assert.equal(await gh.file('a.md', 'main'), 'hi'); assert.equal(await gh.file('a.md', 'main'), 'hi');
  assert.deepEqual(seen.slice(1), [null, '"e1"'], 'branch reads revalidate with If-None-Match');
  const gh2 = client({ token: 't', repo: 'acme/app', fetchImpl, cache: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, freshMs: 60_000 });
  const before = n; await gh2.file('a.md', 'main'); assert.equal(n, before, 'a fresh cached read costs no request');
  gh2.refresh(); await gh2.file('a.md', 'main'); assert.equal(n, before + 1, 'refresh revalidates');
  const anon = client({ repo: 'acme/app', fetchImpl });
  await assert.rejects(anon.req('GET', '/limited'), (e) => e instanceof RateLimitError && /rate limit.*60 requests\/hour without a token.*resets at.*Connect a GitHub token/.test(e.message));
  const urls = []; const raw = client({ repo: 'acme/app', fetchImpl: async (u) => { urls.push(u); return { ok: true, status: 200, text: async () => 'plan' }; } });
  assert.equal(await raw.file('.lake/plans/a.md', sha), 'plan'); await raw.file('.lake/plans/a.md', sha);
  assert.deepEqual(urls, [`https://raw.githubusercontent.com/acme/app/${sha}/.lake/plans/a.md`], 'no token: files come from raw (no API quota), once');
});

test('G-18 loadWorkspace reads the base policy once per branch and can load just one PR', async () => {
  const text = planText(); const gh = fakeGitHub({ files: [PLAN_FILE], contents: { [PLAN_FILE]: text } });
  const c = client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl });
  const one = await loadWorkspace(c, { focus: 7 });
  assert.equal(one.plans.length, 1); assert.equal(one.partial, true);
  assert.equal(gh.calls.filter((x) => x.p === '/pulls').length, 0, 'a deep link does not list PRs');
  assert.equal(gh.calls.filter((x) => x.p === '/contents/.lake/config.json').length, 1);
  assert.equal(gh.calls.filter((x) => x.p === '/pulls/7/files').length, 1, 'files are read once');
});

test('Summary says why a plan was not auto-approved', async () => {
  const gh = fakeGitHub({ prAuthor: 'bot', files: ['.lake/plans/readme.md', 'src/a.js'], contents: { '.lake/plans/readme.md': '# Readme\n\n1. Fix typo in README\n' }, baseConfig: '{}', fileStats: { 'src/a.js': { additions: 220 } } });
  const ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.match(renderSummary(ev), /Not auto-approved \(needs a human\): `readme`: 220 changed lines of code > 150/);
});

function prFake(planFiles) {
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
  const FILE = '# Retries\n\n1. Retry 6 times with exponential backoff\n2. Store the payload\n';
  return async (url, o) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/acme/app', ''); const page = Number(u.searchParams.get('page') || 1);
    const list = (a) => json(page === 1 ? a : []);
    if (p === '/pulls/9') return json({ number: 9, user: { login: 'maya' }, head: { sha: 'h1', ref: 'b' }, base: { sha: 'b0', ref: 'main' } });
    if (p === '/pulls/9/files') return list(planFiles.map((f) => ({ filename: f, status: 'added' })));
    if (p === '/pulls/9/commits') return list([{ sha: 'h1', commit: { committer: { date: '2026-11-12T10:00:00Z' } } }]);
    if (['/issues/9/comments', '/pulls/9/reviews', '/pulls/9/comments'].includes(p)) return list([]);
    if (p === '/commits') return json([{ sha: 'h1' }]);
    if (p.startsWith('/contents/')) return p.includes('config') ? json({ content: Buffer.from('{}').toString('base64') }) : json({ content: Buffer.from(FILE).toString('base64') });
    if (o.method === 'POST') return json({ id: 1, user: { login: 'noah', type: 'User' }, body: JSON.parse(o.body).body, created_at: '2026-11-12T11:00:00Z' }, 201);
    return json({ message: 'unexpected ' + p }, 404);
  };
}

test('G-20 MCP status with no plan named uses the plan on this branch\'s PR, or asks', async () => {
  const root = tmpRepo();
  exportPlan(root, '# Other\n\n1. Something else entirely in src/other.js\n', { id: 'other' }); // the active plan
  const ctx = createContext({ root, gh: client({ token: 't', repo: 'acme/app', fetchImpl: prFake(['.lake/plans/retries.md']) }), prNumber: 9 });
  assert.match(await callTool(ctx, 'lake_review_status', {}), /^Plan retries · /);
  const two = createContext({ root, gh: client({ token: 't', repo: 'acme/app', fetchImpl: prFake(['.lake/plans/a.md', '.lake/plans/b.md']) }), prNumber: 9 });
  await assert.rejects(callTool(two, 'lake_review_status', {}), /PR #9 has 2 plans: a, b\. Pass plan_id/);
});

test('G-12 MCP rejects line 0', async () => {
  const root = tmpRepo();
  const ctx = createContext({ root, gh: client({ token: 't', repo: 'acme/app', fetchImpl: prFake(['.lake/plans/retries.md']) }), prNumber: 9 });
  assert.match(await callTool(ctx, 'lake_review', { action: 'comment', plan_id: 'retries', line: 0, text: 'x' }), /^Not posted: line 0 is outside the plan \(lines 1–\d+\)/);
});

test('G-14 MCP status uses the app\'s words and lists every earlier round', () => {
  const v = (n, login, action, version) => ({ n, login, action, version, text: '', via: 'x' });
  const m = { id: 'p', short: 'cccccccc', digest: 'c'.repeat(64), round: 3, status: 'in-review', policy: { needed: 1, auto: { mode: 'off', reasons: [] } }, estimate: { complexity: 'low', usd: [0.01, 0.02], steps: [] },
    threads: [], verdicts: [], body: '# P\n',
    rounds: [
      { n: 1, short: 'aaaaaaaa', current: false, outcome: 'changes-requested', verdicts: [v(1, 'lee', 'reject', 'a')] },
      { n: 2, short: 'bbbbbbbb', current: false, outcome: 'approved-then-edited', verdicts: [v(2, 'lee', 'approve', 'b'), v(2, 'dana', 'approve', 'b')] },
      { n: 3, short: 'cccccccc', current: true, outcome: 'pending', verdicts: [] }] };
  const out = formatReview(m);
  assert.match(out, /status: In review/);
  assert.match(out, /- round 1 \(vaaaaaaaa\): Changes requested\n    @lee requested changes/);
  assert.match(out, /- round 2 \(vbbbbbbbb\): Approved, then edited\n    @lee approved\n    @dana approved/);
});

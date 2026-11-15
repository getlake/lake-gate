import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/sha256.js';
import { renderPlanFile, digestOf } from '../src/plan.js';
import { parseConfig } from '../src/config-core.js';
import { evaluatePlan, parseCommands } from '../src/policy.js';
import { encodeMarker, parseMarkers, commentBody, replyBody, resolveBody, verdictBody, messageOf, buildPlanReview, versionsFromSnapshots,
  lineDiff, wordDiff, relocateAnchor, expandEvents } from '../src/review.js';
import { client, evaluatePr, renderSummary, fromBase64 } from '../src/github.js';
import { loadPr, actions } from '../src/workspace.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = parseConfig(JSON.stringify({ requiredApprovals: 1 }));

const V1 = renderPlanFile({ id: 'retries', title: 'Retries', author: 'maya', body: '# Retries\n\n## Steps\n1. Retry forever every 30s\n2. Store the payload\n3. Add tests\n', estimateMd: '## Lake estimate\nx' });
const V2 = renderPlanFile({ id: 'retries', title: 'Retries', author: 'maya', body: '# Retries\n\n## Steps\n1. Retry 6 times with exponential backoff\n2. Store the payload\n3. Add tests for backoff\n', estimateMd: '## Lake estimate\ny' });
const d = (t) => versionsFromSnapshots([{ text: t }], 'retries')[0];
let n = 0;
const ev = (login, body, at, extra = {}) => ({ id: `e${n++}`, source: 'comment', login, type: 'User', association: 'MEMBER', body, createdAt: at, ...extra });

test('pure-JS sha256 matches node:crypto, so digests are identical in the browser', () => {
  for (const s of ['', 'abc', 'plan ✓ שלום 😀', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s).digest('hex'));
  }
  assert.equal(fromBase64(Buffer.from('héllo').toString('base64')), 'héllo');
});

test('markers round-trip, survive "--" and never confuse the policy parser', () => {
  const body = commentBody({ planId: 'retries', version: 'abcdef1234', anchor: { start: 4, end: 4, quote: 'a -- b -->' }, text: 'Cap it.', thread: 't1', via: 'test' });
  assert.ok(!body.slice(body.indexOf('<!--') + 4, body.lastIndexOf('-->')).includes('-->'), 'marker must not close early');
  const m = parseMarkers(body)[0];
  assert.equal(m.kind, 'c'); assert.equal(m.data.t, 't1'); assert.equal(m.data.a.q, 'a -- b -->'); assert.equal(m.data.v, 'abcdef12');
  assert.equal(messageOf(body), 'Cap it.');
  assert.equal(parseCommands(body).length, 0);
  const v = verdictBody({ action: 'reject', planId: 'retries', version: 'abcdef1234', text: 'Needs a bound.', resolves: ['t1'] });
  assert.deepEqual(parseCommands(v), [{ action: 'reject', id: 'retries', digest: 'abcdef12' }]);
  assert.equal(messageOf(v), 'Needs a bound.');
  assert.equal(parseMarkers(v).filter((x) => x.kind === 'resolve').length, 1);
  assert.equal(parseMarkers(encodeMarker('c', { p: 'x', q: '<!-- x -->' }))[0].data.q, '<!-- x -->');
});

test('review model: rounds, anchored threads, resolve, outdated anchors, reviewers and timeline', () => {
  const v1 = d(V1); const v2 = d(V2);
  const versions = versionsFromSnapshots([{ text: V1, sha: 's1', at: '2026-11-10T10:00:00Z', author: 'maya' }, { text: V2, sha: 's2', at: '2026-11-11T10:00:00Z', author: 'maya' }], 'retries');
  assert.equal(versions.length, 2);
  const lineOf = (v, needle) => v.body.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const events = [
    ev('noah', commentBody({ planId: 'retries', version: v1.digest, anchor: { start: lineOf(v1, 'forever'), end: lineOf(v1, 'forever'), quote: '1. Retry forever every 30s' }, text: 'Bound it', thread: 'ta' }), '2026-11-10T11:00:00Z'),
    ev('noah', commentBody({ planId: 'retries', version: v1.digest, anchor: { start: lineOf(v1, 'payload'), end: lineOf(v1, 'payload'), quote: '2. Store the payload' }, text: 'Signed?', thread: 'tb' }), '2026-11-10T11:01:00Z'),
    ev('noah', verdictBody({ action: 'reject', planId: 'retries', version: v1.digest, text: 'Bound the retries.' }), '2026-11-10T11:02:00Z'),
    ev('maya', replyBody({ planId: 'retries', thread: 'ta', text: 'Done in v2' }), '2026-11-11T10:01:00Z'),
    ev('maya', resolveBody({ planId: 'retries', thread: 'ta' }), '2026-11-11T10:02:00Z'),
    ev('maya', verdictBody({ action: 'approve', planId: 'retries', version: v2.digest }), '2026-11-11T10:03:00Z'), // author: does not count
    ev('other', '/lake approve otherplan@12345678', '2026-11-11T10:04:00Z'),
  ];
  let m = buildPlanReview({ plan: v2, versions, events, prAuthor: 'maya', config: CFG, pr: { number: 7, draft: false, state: 'open' } });
  assert.equal(m.round, 2);
  assert.equal(m.status, 'in-review');
  assert.equal(m.rounds[0].outcome, 'changes-requested');
  assert.equal(m.rounds[0].verdicts[0].text, 'Bound the retries.');
  assert.ok(m.rounds[1].stats.added >= 2 && m.rounds[1].stats.removed >= 2);
  const ta = m.threads.find((t) => t.id === 'ta'); const tb = m.threads.find((t) => t.id === 'tb');
  assert.equal(ta.resolved, true); assert.equal(ta.resolvedBy, 'maya'); assert.equal(ta.comments.length, 2); assert.equal(ta.outdated, true, 'the "forever" line is gone in v2');
  assert.equal(tb.outdated, false, 'unchanged line relocates'); assert.equal(tb.current.start, lineOf(v2, 'payload'));
  assert.equal(tb.anchor.heading, 'Steps');
  assert.equal(m.openThreads, 1);
  const noah = m.reviewers.find((r) => r.login === 'noah');
  assert.equal(noah.verdict, 'changes-requested'); assert.equal(noah.current, false, 'his reject was on round 1');
  assert.ok(!m.reviewers.some((r) => r.login === 'maya'), 'the author is not a reviewer');
  assert.ok(m.verdicts.find((v) => v.login === 'maya').self);
  assert.deepEqual(m.timeline.map((t) => t.kind), ['version', 'comment', 'comment', 'reject', 'version', 'reply', 'resolve', 'approve']);

  // A teammate approves v2 from the UI: approved, and the policy agrees.
  m = buildPlanReview({ plan: v2, versions, events: [...events, ev('leo', verdictBody({ action: 'approve', planId: 'retries', version: v2.digest, via: 'Lake review' }), '2026-11-11T12:00:00Z')], prAuthor: 'maya', config: CFG, pr: { number: 7 } });
  assert.equal(m.status, 'approved'); assert.deepEqual(m.policy.approvers, ['leo']);
  assert.equal(m.reviewers.find((r) => r.login === 'leo').via, 'Lake review');
  assert.equal(m.rounds[1].outcome, 'approved');
});

test('native GitHub review buttons and line comments map onto the same model; proxy approvals only from the Actions bot', () => {
  const v1 = d(V1); const v2 = d(V2);
  const versions = versionsFromSnapshots([{ text: V1, sha: 's1' }, { text: V2, sha: 's2' }], 'retries');
  const digestAt = { s1: v1.digest, s2: v2.digest };
  const approveOld = { id: 'r1', source: 'review', state: 'APPROVED', commitId: 's1', login: 'leo', type: 'User', association: 'MEMBER', body: 'lgtm', createdAt: '1' };
  let m = buildPlanReview({ plan: v2, versions, events: [approveOld], prAuthor: 'maya', config: CFG, digestAt, pr: { number: 7 } });
  assert.equal(m.status, 'in-review', 'a native approval of the OLD commit does not approve the edited plan');
  assert.equal(m.verdicts[0].via, 'GitHub review'); assert.equal(m.verdicts[0].n, 1);
  m = buildPlanReview({ plan: v2, versions, events: [{ ...approveOld, commitId: 's2' }], prAuthor: 'maya', config: CFG, digestAt, pr: { number: 7 } });
  assert.equal(m.status, 'approved');
  m = buildPlanReview({ plan: v2, versions, events: [{ ...approveOld, commitId: 's2' }], prAuthor: 'maya', config: parseConfig('{"nativeReviews":false}'), digestAt, pr: { number: 7 } });
  assert.equal(m.status, 'in-review', 'can be turned off');
  m = buildPlanReview({ plan: v2, versions, events: [{ ...approveOld, state: 'CHANGES_REQUESTED', commitId: 's2', body: 'no' }], prAuthor: 'maya', config: CFG, digestAt, pr: { number: 7 } });
  assert.equal(m.status, 'changes-requested');

  const line = v2.offset + v2.body.split('\n').findIndex((l) => l.includes('payload')) + 1;
  const lc = { id: 'l55', source: 'line', path: '.lake/plans/retries.md', line, commitId: 's2', login: 'leo', type: 'User', body: 'Sign it', createdAt: '2' };
  const reply = { id: 'l56', source: 'line', path: '.lake/plans/retries.md', line, commitId: 's2', inReplyTo: 'l55', login: 'maya', type: 'User', body: 'ok', createdAt: '3' };
  m = buildPlanReview({ plan: v2, versions, events: [lc, reply], prAuthor: 'maya', config: CFG, digestAt, pr: { number: 7 } });
  assert.equal(m.threads.length, 1); assert.equal(m.threads[0].source, 'github'); assert.equal(m.threads[0].comments.length, 2);
  assert.match(m.threads[0].anchor.quote, /Store the payload/);

  const body = verdictBody({ action: 'approve', planId: 'retries', version: v2.digest }) + encodeMarker('proxy', { by: 'leo', assoc: 'COLLABORATOR' });
  const fromBot = { id: 'p1', source: 'comment', login: 'github-actions[bot]', type: 'Bot', association: 'NONE', body, createdAt: '4' };
  assert.equal(buildPlanReview({ plan: v2, versions, events: [fromBot], prAuthor: 'maya', config: CFG, pr: { number: 7 } }).status, 'approved');
  const forged = { ...fromBot, login: 'mallory', type: 'User', association: 'MEMBER' };
  const r = evaluatePlan({ plan: v2, events: expandEvents([forged], { planId: 'retries', config: CFG }), prAuthor: 'maya', config: CFG });
  assert.deepEqual(r.approvers, ['mallory'], 'a human-posted proxy marker is just that human\'s own approval, never someone else\'s');
});

test('diff and anchor relocation', () => {
  const dd = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(dd.map((x) => x.op), ['same', 'del', 'add', 'same', 'add']);
  const wd = wordDiff('retry every 30s', 'retry 6 times'); assert.equal(wd[0].op, 'same'); assert.equal(wd.filter((x) => x.op !== 'del').map((x) => x.text).join(''), 'retry 6 times'); assert.equal(wd.filter((x) => x.op !== 'add').map((x) => x.text).join(''), 'retry every 30s');
  assert.deepEqual(relocateAnchor({ start: 2, end: 2, quote: '2. Store the payload' }, 'x\ny\nz\n3. Store the payload\n'), { start: 4, end: 4 });
  assert.equal(relocateAnchor({ start: 2, end: 2, quote: 'gone' }, 'x\ny'), null);
});

// A GitHub API fake with commits, files at refs, issue comments, reviews and line comments.
function fakeRepo({ commits, files, comments = [], reviews = [], lines = [], config = null, prUser = 'maya' }) {
  const calls = [];
  const head = commits[commits.length - 1].sha;
  const pr = { number: 9, title: 'Retries', user: { login: prUser }, head: { sha: head, ref: 'maya/retries' }, base: { sha: 'base' }, html_url: 'https://github.com/acme/app/pull/9', draft: false, state: 'open', requested_reviewers: [{ login: 'noah' }] };
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/acme/app', ''); const m = opts.method; const page = Number(u.searchParams.get('page') || 1);
    calls.push({ m, p, body: opts.body ? JSON.parse(opts.body) : null });
    const list = (a) => json(page === 1 ? a : []);
    if (m === 'GET' && p === '/pulls/9') return json(pr);
    if (m === 'GET' && p === '/pulls') return json([pr]);
    if (m === 'GET' && p === '/pulls/9/files') return list(Object.keys(files).map((f) => ({ filename: f, status: 'modified' })));
    if (m === 'GET' && p === '/pulls/9/commits') return list(commits.map((c) => ({ sha: c.sha, commit: { committer: { date: c.at } }, author: { login: prUser } })));
    if (m === 'GET' && p === '/issues/9/comments') return list(comments);
    if (m === 'GET' && p === '/pulls/9/reviews') return list(reviews);
    if (m === 'GET' && p === '/pulls/9/comments') return list(lines);
    if (m === 'GET' && p === '/commits') { const f = u.searchParams.get('path'); return json(commits.filter((c) => c.touches?.includes(f)).reverse().map((c) => ({ sha: c.sha }))); }
    if (m === 'GET' && p.startsWith('/contents/')) {
      const f = decodeURIComponent(p.slice(10)); const ref = u.searchParams.get('ref');
      if (f === '.lake/config.json') return config ? json({ content: Buffer.from(config).toString('base64') }) : json({}, 404);
      const v = files[f]?.[ref]; return v == null ? json({ message: 'Not Found' }, 404) : json({ content: Buffer.from(v).toString('base64') });
    }
    if (m === 'GET' && p === '/collaborators/noah/permission') return json({ permission: 'write' });
    if (m === 'GET' && p === '/collaborators/rita/permission') return json({ permission: 'read' });
    if (m === 'POST' && p === '/issues/9/comments') { const b = JSON.parse(opts.body).body; const bot = /lake-gate:summary|lake:proxy/.test(b); const c = { id: 900 + calls.length, user: bot ? { login: 'github-actions[bot]', type: 'Bot' } : { login: 'noah', type: 'User' }, author_association: bot ? 'NONE' : 'MEMBER', body: JSON.parse(opts.body).body, created_at: '2026-11-12T00:00:00Z' }; comments.push(c); return json(c, 201); }
    if (m === 'PATCH' && p.startsWith('/issues/comments/')) { const c = comments.find((x) => String(x.id) === p.split('/').pop()); if (c) c.body = JSON.parse(opts.body).body; return json(c || {}); }
    if (m === 'POST') return json({ id: 1, user: { login: 'noah', type: 'User' }, body: JSON.parse(opts.body || '{}').body, created_at: '2026-11-12T00:00:00Z' }, 201);
    return json({ message: 'unexpected ' + p }, 404);
  };
  return { fetchImpl, calls, pr, comments };
}
const PLAN_PATH = '.lake/plans/retries.md';
const repoFixture = (extra = {}) => fakeRepo({
  commits: [{ sha: 'c1', at: '2026-11-10T10:00:00Z', touches: [PLAN_PATH] }, { sha: 'c2', at: '2026-11-10T12:00:00Z', touches: ['src/x.ts'] }, { sha: 'c3', at: '2026-11-11T10:00:00Z', touches: [PLAN_PATH] }],
  files: { [PLAN_PATH]: { c1: V1, c2: V1, c3: V2 } }, ...extra,
});
const ghc = (f) => client({ token: 't', repo: 'acme/app', fetchImpl: f.fetchImpl });

test('workspace: loads versions from PR commits, maps native reviews, and writes verdicts as PR comments', async () => {
  const f = repoFixture({ reviews: [{ id: 1, user: { login: 'leo', type: 'User' }, author_association: 'MEMBER', state: 'APPROVED', body: 'ok', commit_id: 'c2', submitted_at: '2026-11-10T13:00:00Z' }] });
  let { plans } = await loadPr(ghc(f), 9);
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.round, 2); assert.equal(p.rounds[0].sha, 'c1'); assert.equal(p.digest, digestOf(d(V2).body));
  assert.equal(p.status, 'in-review', 'leo approved c2, which still had v1');
  assert.equal(p.verdicts[0].n, 1);
  assert.equal(p.reviewers.find((r) => r.login === 'noah').verdict, 'waiting');
  await actions.verdict(ghc(f), 9, { action: 'approve', planId: 'retries', version: p.digest, text: 'Ship it', via: 'Lake review' });
  const posted = f.calls.find((c) => c.m === 'POST' && c.p === '/issues/9/comments');
  assert.match(posted.body.body, new RegExp(`^/lake approve retries@${p.short}`));
  ({ plans } = await loadPr(ghc(f), 9));
  assert.equal(plans[0].status, 'approved'); assert.equal(plans[0].reviewers.find((r) => r.login === 'noah').via, 'Lake review');
  await actions.comment(ghc(f), 9, { planId: 'retries', version: p.digest, anchor: { start: 4, end: 4, quote: 'Retry 6 times' }, text: 'Why 6?', thread: 'q1' });
  await actions.resolve(ghc(f), 9, { planId: 'retries', thread: 'q1' });
  ({ plans } = await loadPr(ghc(f), 9));
  assert.equal(plans[0].threads[0].resolved, true);
  await actions.reply(ghc(f), 9, { planId: 'retries', thread: 'l77', text: 'native reply' });
  assert.ok(f.calls.some((c) => c.m === 'POST' && c.p === '/pulls/9/comments/77/replies'));
});

test('PR check: native "Approve" counts for the version at the reviewed commit; summary has one-click buttons', async () => {
  let f = repoFixture({ reviews: [{ id: 1, user: { login: 'leo', type: 'User' }, author_association: 'MEMBER', state: 'APPROVED', body: '', commit_id: 'c3', submitted_at: '2026-11-11T11:00:00Z' }] });
  let evr = await evaluatePr(ghc(f), 9);
  assert.equal(evr.state, 'success');
  f = repoFixture({ reviews: [{ id: 1, user: { login: 'leo', type: 'User' }, author_association: 'MEMBER', state: 'APPROVED', body: '', commit_id: 'c1', submitted_at: '2026-11-10T11:00:00Z' }] });
  evr = await evaluatePr(ghc(f), 9);
  assert.equal(evr.state, 'failure', 'approval of an older plan version does not carry over');
  const md = renderSummary(evr);
  assert.match(md, /getlake\.github\.io\/lake-gate\/app\/#\/pr\/acme\/app\/9\/retries\?do=approve&v=/);
  assert.match(md, /btn\/approve\.svg/);
  assert.match(md, /Review changes → Approve/);
  assert.match(md, /\/lake approve retries@/);
  f = repoFixture({ config: JSON.stringify({ reviewUrl: '', nativeReviews: false }) });
  assert.doesNotMatch(renderSummary(await evaluatePr(ghc(f), 9)), /btn\/approve|Review changes/);
});

test('experimental check-run buttons: a click by a writer is relayed and counts; readers and stale clicks are ignored', async () => {
  const { runAction, checkActions } = await import('../src/action.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-cb-'));
  const evPath = path.join(dir, 'e.json');
  const f = repoFixture({ config: JSON.stringify({ checkButtons: true }) });
  const short = d(V2).short;
  const run = (sender, identifier, headSha = 'c3') => { fs.writeFileSync(evPath, JSON.stringify({ action: 'requested_action', requested_action: { identifier }, sender: { login: sender, type: 'User' }, check_run: { head_sha: headSha, pull_requests: [{ number: 9 }] } })); return runAction({ GITHUB_EVENT_PATH: evPath, GITHUB_EVENT_NAME: 'check_run', GITHUB_REPOSITORY: 'acme/app', INPUT_TOKEN: 't' }, f.fetchImpl); };
  let r = await run('rita', `approve:${short}`);
  assert.equal(r.state, 'failure');
  r = await run('noah', `approve:${short}`, 'old');
  assert.equal(r.state, 'failure');
  const check = f.calls.filter((c) => c.p === '/check-runs').pop();
  assert.deepEqual(check.body.actions.map((a) => a.identifier), [`approve:${short}`, `reject:${short}`]);
  assert.ok(check.body.actions.every((a) => a.label.length <= 20 && a.description.length <= 40 && a.identifier.length <= 20));
  r = await run('noah', `approve:${short}`);
  assert.equal(r.state, 'success');
  const relayed = f.comments.find((c) => /lake:proxy/.test(c.body));
  assert.match(relayed.body, /"by":"noah"/);
  assert.equal(checkActions({ results: [] }).length, 0);
});

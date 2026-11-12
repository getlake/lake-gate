import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpRepo, PLAN, fakeGitHub, comment } from './helpers.js';
import { applyEvents } from '../src/sync.js';
import { loadPlan, getState } from '../src/store.js';
import { client, evaluatePr, publish, MARKER } from '../src/github.js';
import { runAction } from '../src/action.js';
import { mergeClaudeSettings } from '../src/init.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lake-gate.js');
const cli = (cwd, args, input) => spawnSync('node', [BIN, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, LAKE_GATE: '' } });
const hook = (cwd, payload) => {
  const r = cli(cwd, ['hook', 'claude'], JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', permission_mode: 'default', ...payload }));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
const decision = (o) => o?.hookSpecificOutput?.permissionDecision ?? 'none';

test('end to end: init, plan mode export, gate, approval, edit invalidates, re-approval', () => {
  const repo = tmpRepo();
  const init = cli(repo, ['init']);
  assert.equal(init.status, 0, init.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'ExitPlanMode|Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.ok(fs.existsSync(path.join(repo, '.github/workflows/lake-gate.yml')));

  const write = { tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src/queue.ts'), content: 'x' } };
  // 1. No plan yet: implementation is blocked, reads are not gated.
  assert.equal(decision(hook(repo, write)), 'deny');
  assert.equal(hook(repo, { tool_name: 'Read', tool_input: { file_path: path.join(repo, 'app.js') } }), null);
  assert.equal(hook(repo, { ...write, permission_mode: 'plan' }), null);

  // 2. Claude exits plan mode: the injected plan is exported with an estimate.
  const saved = hook(repo, { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN, planFilePath: '/home/u/.claude/plans/x.md' } });
  assert.match(saved.systemMessage, /\.lake\/plans\/add-webhook-retries\.md/);
  const plan = loadPlan(repo, 'add-webhook-retries');
  assert.match(fs.readFileSync(plan.path, 'utf8'), /Recommended model/);
  assert.equal(getState(repo).active, 'add-webhook-retries');

  // 3. Still unapproved: writes and mutating Bash are denied; read-only Bash and plan edits pass.
  const denied = hook(repo, write);
  assert.equal(decision(denied), 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, new RegExp(`/lake approve add-webhook-retries@${plan.short}`));
  assert.equal(decision(hook(repo, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } })), 'deny');
  assert.equal(decision(hook(repo, { tool_name: 'Bash', tool_input: { command: 'git status && rm -rf src' } })), 'deny');
  assert.equal(hook(repo, { tool_name: 'Bash', tool_input: { command: 'git diff | head -50' } }), null);
  assert.equal(hook(repo, { tool_name: 'Bash', tool_input: { command: 'rg TODO src' } }), null);
  assert.equal(decision(hook(repo, { tool_name: 'Bash', tool_input: { command: 'echo {} > .git/lake/approvals.json' } })), 'deny');
  assert.equal(decision(hook(repo, { tool_name: 'Bash', tool_input: { command: 'npx lake-gate use other' } })), 'deny');
  assert.equal(decision(hook(repo, { tool_name: 'Write', tool_input: { file_path: path.join(repo, '.git/lake/approvals.json'), content: '{}' } })), 'deny');
  assert.equal(cli(repo, ['check']).status, 1);

  // 4. The author approving on GitHub does not count; a teammate does.
  const line = `/lake approve add-webhook-retries@${plan.short}`;
  applyEvents(repo, { prAuthor: 'maya', events: [{ login: 'maya', type: 'User', association: 'OWNER', body: line, createdAt: '1' }] });
  assert.equal(decision(hook(repo, write)), 'deny');
  applyEvents(repo, { prAuthor: 'maya', events: [{ login: 'noah', type: 'User', association: 'MEMBER', body: line, createdAt: '2' }] });
  assert.equal(hook(repo, write), null);
  assert.equal(hook(repo, { tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  assert.equal(cli(repo, ['check']).status, 0);

  // 5. Editing the plan creates a new version and the old approval no longer applies.
  fs.writeFileSync(plan.path, fs.readFileSync(plan.path, 'utf8').replace('exponential backoff', 'exponential backoff and jitter'));
  const after = hook(repo, write);
  assert.equal(decision(after), 'deny');
  assert.match(after.hookSpecificOutput.permissionDecisionReason, /edited after it was approved/);
  const v2 = loadPlan(repo, plan.id);
  assert.notEqual(v2.short, plan.short);
  applyEvents(repo, { prAuthor: 'maya', events: [{ login: 'noah', type: 'User', association: 'MEMBER', body: `/lake approve ${plan.id}@${v2.short}`, createdAt: '3' }] });
  assert.equal(hook(repo, write), null);

  // 6. Re-exporting from the same Claude session revises the same plan file; the generated estimate is not part of the version.
  hook(repo, { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN + '5. Add a metrics counter\n' } });
  assert.equal(fs.readdirSync(path.join(repo, '.lake/plans')).filter((f) => f !== 'README.md').length, 1);
  assert.equal(decision(hook(repo, write)), 'deny');

  // 7. Escape hatch is explicit and human-controlled (env of the Claude process).
  const off = spawnSync('node', [BIN, 'hook', 'claude'], { cwd: repo, input: JSON.stringify({ cwd: repo, ...write }), encoding: 'utf8', env: { ...process.env, LAKE_GATE: 'off' } });
  assert.equal(off.stdout.trim(), '');
});

test('small plans pass with auto-approve on, and only then', () => {
  const repo = tmpRepo();
  cli(repo, ['init']);
  const cfgPath = path.join(repo, '.lake/config.json');
  const r = cli(repo, ['plan', '-', '--id', 'readme-typo'], '# Readme\n1. Fix typo in README\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cli(repo, ['check']).status, 1); // shadow mode by default
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfg.autoApprove.mode = 'on'; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(cli(repo, ['check']).status, 0);
  cli(repo, ['plan', '-', '--id', 'big'], PLAN);
  assert.equal(cli(repo, ['check']).status, 1);
});

test('GitHub check: base-branch config, non-author approval, status and sticky comment', async () => {
  const planText = fs.readFileSync(path.join(tmpPlanRepo(), '.lake/plans/add-webhook-retries.md'), 'utf8');
  const { readPlanText } = await import('../src/plan.js');
  const short = readPlanText(planText).short;
  const files = ['.lake/plans/add-webhook-retries.md', 'src/queue.ts'];
  // PR tries to loosen its own policy: ignored because config comes from the base branch.
  const contents = { '.lake/plans/add-webhook-retries.md': planText, '.lake/config.json@head-config': JSON.stringify({ requiredApprovals: 0 }) };
  let gh = fakeGitHub({ files, contents, comments: [comment('maya', `/lake approve add-webhook-retries@${short}`, '2026-11-12T08:00:00Z', { association: 'OWNER' })] });
  let ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'failure');
  assert.match(ev.description, new RegExp(`/lake approve add-webhook-retries@${short}`));
  await publish(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), ev);
  const status = gh.calls.find((c) => c.p === '/statuses/headsha');
  assert.equal(status.body.context, 'lake/plan-approval');
  assert.equal(status.body.state, 'failure');
  const posted = gh.calls.find((c) => c.m === 'POST' && c.p === '/issues/7/comments');
  assert.ok(posted.body.body.startsWith(MARKER));
  assert.match(posted.body.body, /author cannot approve/);

  gh = fakeGitHub({ files, contents, reviews: [{ id: 3, user: { login: 'noah', type: 'User' }, author_association: 'MEMBER', state: 'COMMENTED', body: `Looks right.\n/lake approve add-webhook-retries@${short}`, submitted_at: '2026-11-12T09:00:00Z' }],
    comments: [comment('github-actions[bot]', MARKER + '\nold', '2026-11-12T08:00:00Z', { type: 'Bot' })] });
  ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'success');
  await publish(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), ev);
  assert.ok(gh.calls.some((c) => c.m === 'PATCH'), 'updates the existing summary comment instead of adding one');

  // Code without a plan: warn by default, fail when the base config says so.
  gh = fakeGitHub({ files: ['src/x.ts'], baseConfig: JSON.stringify({ requirePlan: 'fail' }) });
  ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'failure');
  gh = fakeGitHub({ files: ['src/x.ts'] });
  ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'success'); assert.match(ev.description, /Warning/);
});

test('action entry point reads the event payload (issue_comment on a PR)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-action-'));
  const evPath = path.join(dir, 'event.json');
  fs.writeFileSync(evPath, JSON.stringify({ issue: { number: 7, pull_request: {} }, comment: { body: '/lake approve x@1234567' } }));
  const summary = path.join(dir, 'summary.md'); const output = path.join(dir, 'out.txt');
  const gh = fakeGitHub({ files: ['README.md'] });
  const ev = await runAction({ GITHUB_EVENT_PATH: evPath, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REPOSITORY: 'acme/app', INPUT_TOKEN: 't', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }, gh.fetchImpl);
  assert.equal(ev.state, 'success');
  assert.match(fs.readFileSync(output, 'utf8'), /state=success/);
  fs.writeFileSync(evPath, JSON.stringify({ issue: { number: 8 } }));
  assert.equal(await runAction({ GITHUB_EVENT_PATH: evPath, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REPOSITORY: 'acme/app' }, gh.fetchImpl), null);
});

test('init keeps existing Claude hooks and is idempotent', () => {
  const existing = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
  const a = mergeClaudeSettings(existing);
  assert.equal(a.settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(a.settings.permissions, existing.permissions);
  assert.equal(mergeClaudeSettings(a.settings).changed, false);
});

function tmpPlanRepo() {
  const repo = tmpRepo();
  cli(repo, ['init']);
  cli(repo, ['plan', '-'], PLAN);
  return repo;
}

// Regression tests for QA run 1 on 0.2.2 (G-01 … G-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfig, safeParseConfig } from '../src/config-core.js';
import { estimatePlan, autoApproveVerdict, money } from '../src/estimate.js';
import { handleClaudePreToolUse, isReadOnly } from '../src/hook.js';
import { exportPlan, localStatus, loadPlan } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { init } from '../src/init.js';
import { client, evaluatePr, renderSummary, collectEvents, MARKER } from '../src/github.js';
import { readPlanText } from '../src/plan.js';
import { tmpRepo, fakeGitHub, comment, PLAN } from './helpers.js';

const hook = (root, tool, input, sid = 's1') => handleClaudePreToolUse({ cwd: root, session_id: sid, tool_name: tool, tool_input: input }, {});
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const TINY = '# Readme\n1. Fix typo in README\n';

function repoWith(planText) {
  const root = tmpRepo(); init(root, {});
  execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'lake'], { cwd: root });
  const r = exportPlan(root, planText, { source: 'cli' });
  return { root, plan: r.plan };
}

test('G-01 a blocked plan cannot be rewritten by the agent, and shrinking it never earns an auto pass', () => {
  const { root, plan } = repoWith(PLAN);
  const file = path.join(root, '.lake/plans', `${plan.id}.md`);
  assert.ok(denied(hook(root, 'Write', { file_path: file, content: TINY })), 'Write to the plan file is denied');
  assert.ok(denied(hook(root, 'Edit', { file_path: path.join(root, '.lake/config.json'), old_string: '1', new_string: '0' })), 'policy edits are denied');
  assert.ok(denied(hook(root, 'Bash', { command: `printf '1. Fix typo' > .lake/plans/${plan.id}.md` })));
  // Even if the file is rewritten some other way, the plan stays gated: a shrunk version needs a human.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n1\.[\s\S]*$/, '\n1. Fix typo in README\n'));
  assert.equal(localStatus(root, loadPlan(root, plan.id), loadConfig(root)).state, 'pending');
  assert.ok(denied(hook(root, 'Write', { file_path: path.join(root, 'src/billing.js'), content: 'x' })));
  // Re-saving through the CLI is a new version, still not auto-approved.
  const again = exportPlan(root, TINY.replace('# Readme', `# ${plan.title}`), { id: plan.id, source: 'cli' });
  assert.equal(localStatus(root, again.plan, loadConfig(root)).state, 'pending');
});

test('G-01 an auto-approved tiny plan stops covering work once the diff grows', () => {
  const { root } = repoWith(TINY);
  assert.equal(hook(root, 'Write', { file_path: path.join(root, 'README.md'), content: 'fixed\n' }), null);
  const big = Array.from({ length: 200 }, (_, i) => `export const f${i} = () => ${i};`).join('\n');
  const r = hook(root, 'Write', { file_path: path.join(root, 'src/billing.js'), content: big });
  assert.ok(denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /grown past it/);
});

test('G-01 on the PR: a tiny plan with a big code diff, or a shrunk plan, needs a human', async () => {
  const text = `---\nid: readme\n---\n${TINY}`;
  const files = ['.lake/plans/readme.md', 'src/payments/billing.js'];
  const gh = fakeGitHub({ prAuthor: 'bot', files, contents: { '.lake/plans/readme.md': text }, baseConfig: '{}', fileStats: { 'src/payments/billing.js': { additions: 400, deletions: 0 } } });
  const ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.state, 'failure');
  assert.match(ev.results[0].auto.reasons.join(' '), /400 changed lines/);
  const small = fakeGitHub({ prAuthor: 'bot', files, contents: { '.lake/plans/readme.md': text }, baseConfig: '{}', fileStats: { 'src/payments/billing.js': { additions: 3, deletions: 1 } } });
  assert.equal((await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: small.fetchImpl }), 7)).state, 'success');
  const est = estimatePlan(TINY, parseConfig(null));
  assert.equal(autoApproveVerdict(est, parseConfig(null), { gatedBefore: true }).eligible, false);
  assert.equal(autoApproveVerdict(estimatePlan('', parseConfig(null)), parseConfig(null)).eligible, false, 'no steps, no auto pass');
});

test('G-02 a hand-edited config with a trailing comma or comments works; a broken one fails safe with file and line', () => {
  assert.equal(parseConfig('{ "requiredApprovals": 2, }').requiredApprovals, 2);
  assert.equal(parseConfig('{\n // team policy\n "requiredApprovals": 3 /* two leads */\n}').requiredApprovals, 3);
  const bad = safeParseConfig('{\n  "requiredApprovals": 1\n  "x": 2\n}');
  assert.match(bad.configError, /\.lake\/config\.json is not valid JSON \(line 3, column 3\)/);
  const { root } = repoWith(PLAN);
  fs.writeFileSync(path.join(root, '.lake/config.json'), '{ "requiredApprovals": 1 "oops" }');
  const ok = hook(root, 'Bash', { command: 'git status' });
  assert.ok(!denied(ok));
  assert.match(ok.systemMessage, /\.lake\/config\.json is not valid JSON.*last valid policy/);
  assert.ok(denied(hook(root, 'Write', { file_path: path.join(root, 'src/x.js'), content: 'x' })), 'gated work stays gated with the defaults');
});

test('G-03 the PR check uses the policy at the head of the base branch, and warns on a broken one', async () => {
  const planText = fs.readFileSync(path.join(repoWith(PLAN).root, '.lake/plans/add-webhook-retries.md'), 'utf8');
  const short = readPlanText(planText).short;
  const files = ['.lake/plans/add-webhook-retries.md'];
  const comments = [comment('lee', `/lake approve add-webhook-retries@${short}`, '2026-11-12T08:00:00Z')];
  const gh = fakeGitHub({ files, contents: { '.lake/plans/add-webhook-retries.md': planText }, comments,
    baseShaConfig: '{}', baseConfig: '{"budget":{"approverAbove":1,"approvers":["dana"]}}' });
  const ev = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7);
  assert.equal(ev.results[0].state, 'needs-budget');
  assert.match(renderSummary(ev), /@dana must approve/);
  const broken = fakeGitHub({ files, contents: { '.lake/plans/add-webhook-retries.md': planText }, comments, baseConfig: '{ "requiredApprovals": 1 "x" }' });
  const ev2 = await evaluatePr(client({ token: 't', repo: 'acme/app', fetchImpl: broken.fetchImpl }), 7);
  assert.match(renderSummary(ev2), /Error:.*not valid JSON.*fails closed/);
  assert.equal(ev2.state, 'failure');
});

test('G-04 the summary comment is not read as a command', async () => {
  const gh = fakeGitHub({ comments: [comment('github-actions[bot]', `${MARKER}\n/lake approve x@12345678`, '2026-11-12T08:00:00Z', { type: 'Bot' })] });
  assert.equal((await collectEvents(client({ token: 't', repo: 'acme/app', fetchImpl: gh.fetchImpl }), 7)).length, 0);
});

test('G-05 an empty plan is not saved', () => {
  const root = tmpRepo();
  assert.throws(() => exportPlan(root, '   \n', { source: 'cli' }), /No plan text/);
  assert.throws(() => exportPlan(root, '# Title only\n', { source: 'cli' }), /No steps/);
});

test('G-06 read-only shell commands only', () => {
  const cfg = parseConfig(null);
  for (const c of ['git status\nrm -rf src', 'env rm -rf src', 'find src -name "*.js" -delete', 'find . -exec rm {} ;', 'git branch -D main', 'git remote add x y'])
    assert.equal(isReadOnly(c, cfg), false, c);
  for (const c of ['git status', 'ls -la', 'env', 'find src -name "*.js"', 'git branch -a', 'rg foo | head -5'])
    assert.equal(isReadOnly(c, cfg), true, c);
});

test('G-15 large amounts get thousands separators', () => {
  assert.equal(money(24660.2), '$24,660');
});

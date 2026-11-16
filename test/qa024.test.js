// Regression tests for QA's pass on 0.2.4 (G-21, G-22).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleClaudePreToolUse } from '../src/hook.js';
import { exportPlan, getState, setState } from '../src/store.js';
import { init } from '../src/init.js';
import { evaluatePlan } from '../src/policy.js';
import { parseConfig } from '../src/config-core.js';
import { tmpRepo, PLAN } from './helpers.js';

const git = (root, ...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
const hook = (root, sid = 's1') => handleClaudePreToolUse({ cwd: root, session_id: sid, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/x.js'), content: 'x' } }, {});
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('G-21 the local gate follows the checked-out branch, not the last active plan', () => {
  const root = tmpRepo(); init(root, {});
  fs.writeFileSync(path.join(root, '.lake/config.json'), '{"autoApprove":{"mode":"off"}}');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'lake');
  git(root, 'checkout', '-qb', 'plan/a');
  exportPlan(root, PLAN, { id: 'plan-a', source: 'cli' });
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'plan a');
  git(root, 'checkout', '-q', 'main'); git(root, 'checkout', '-qb', 'plan/b');
  exportPlan(root, '# Delivery log\n\n1. Add a delivery log table\n2. Show it in the admin page\n', { id: 'plan-b', source: 'cli' });
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'plan b');
  const st = getState(root); st.active = 'plan-b'; st.sessions = {}; setState(root, st);
  git(root, 'checkout', '-q', 'plan/a'); // plan-b's file is not in this checkout
  const r = hook(root, 'fresh');
  assert.ok(denied(r), JSON.stringify(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /plan "plan-a"/);
  assert.ok(denied(hook(root, 'fresh')), 'still gated on the next call');
  git(root, 'checkout', '-q', 'main');
  assert.ok(!denied(hook(root, 'fresh')), 'main has no plan: not gated');
});

test('G-22 one hint for a malformed /lake command, gone after a valid one', () => {
  const plan = { id: 'p', digest: 'abcdef0123456789', short: 'abcdef01' };
  const ev = (body, at) => ({ login: 'lee', type: 'User', association: 'MEMBER', body, createdAt: at, source: 'comment' });
  const cfg = parseConfig(null);
  let r = evaluatePlan({ plan, events: [ev('/lake approve', '1'), ev('/lake approve p@', '2')], config: cfg });
  assert.deepEqual(r.notes, ['@lee: missing version in "/lake approve p": use /lake approve p@abcdef01']);
  r = evaluatePlan({ plan, events: [ev('/lake approve', '1'), ev('/lake approve p@', '2'), ev('/lake approve p@abcdef01', '3')], config: cfg });
  assert.deepEqual(r.notes, []); assert.equal(r.state, 'approved');
});

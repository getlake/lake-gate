import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../src/config-core.js';
import { estimatePlan, costLabel, range, renderEstimate } from '../src/estimate.js';
import { evaluatePlan } from '../src/policy.js';
import { readPlanText } from '../src/plan.js';
import { modelOptions } from '../src/models.js';
import { resolveBudgetApprovers } from '../src/github.js';
import { exportPlan } from '../src/store.js';
import { init, uninstall } from '../src/init.js';
import { tmpRepo, PLAN, comment } from './helpers.js';

const cfg = parseConfig(null);
const MIXED = '# Retries\n\nModel: Opus 5.5\n\n1. Add a bounded retry queue with exponential backoff\n2. Database migration for a retry_count column\n3. Fix typo in README (model: haiku)\n';

test('mixed per-step models are labelled as such, single-model plans keep "on X"', () => {
  const mixed = estimatePlan(MIXED, cfg);
  assert.match(costLabel(mixed), /· planned per step \(default Opus 5\.5\)$/);
  assert.doesNotMatch(costLabel(mixed), / on Opus/);
  assert.match(renderEstimate(mixed, cfg), /Planned per step \(default \*\*Opus 5\.5\*\*\)/);
  const single = estimatePlan(MIXED.replace(' (model: haiku)', ''), cfg);
  assert.match(costLabel(single), / on Opus 5\.5$/);
});

test('tiny amounts read "<$0.01", and the picker hides other vendors unless configured', () => {
  assert.equal(range([0.0001, 0.004]), '<$0.01');
  const est = estimatePlan(MIXED, cfg);
  const names = modelOptions(est, cfg).map((o) => o.key).join(' ');
  assert.doesNotMatch(names, /gpt/);
});

test('an unreadable @org/team warns and falls back instead of getting stuck', async () => {
  const config = parseConfig(JSON.stringify({ budget: { approverAbove: 1, approvers: ['@acme/leads'] } }));
  const gh = { all: async () => { throw new Error('403'); } };
  const list = await resolveBudgetApprovers(gh, config);
  assert.deepEqual(list.unreadable, ['@acme/leads']);
  assert.equal(list.fallback, 'owner');
  const plan = { ...readPlanText(PLAN), id: 'add-webhook-retries' };
  const r = evaluatePlan({ plan, estimate: estimatePlan(plan.body, config), events: [{ ...ev(comment('olga', `/lake approve ${plan.id}@${plan.short}`, '2026-01-01T00:00:00Z', { association: 'OWNER' })) }], prAuthor: 'maya', config, budgetApprovers: list });
  assert.equal(r.budget.required, true);
  assert.equal(r.budget.satisfied, true);
});
function ev(c) { return { login: c.user.login, type: c.user.type, association: c.author_association, body: c.body, createdAt: c.created_at }; }

test('re-running plan with the same title makes a new version, --new makes a copy; uninstall keeps plans', () => {
  const root = tmpRepo();
  init(root, {});
  const a = exportPlan(root, PLAN, { source: 'cli' });
  const b = exportPlan(root, PLAN + '\nOne more line.\n', { source: 'cli' });
  assert.equal(b.plan.id, a.plan.id);
  assert.equal(b.previous.short, a.plan.short);
  const c = exportPlan(root, PLAN, { source: 'cli', fresh: true });
  assert.notEqual(c.plan.id, a.plan.id);
  const out = uninstall(root);
  assert.ok(out.some((l) => /hook/.test(l)));
  assert.ok(!fs.existsSync(path.join(root, '.mcp.json')));
  assert.ok(fs.existsSync(path.join(root, '.lake', 'plans', `${a.plan.id}.md`)));
});

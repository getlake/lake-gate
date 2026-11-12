import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, extractSteps, readPlanText, renderPlanFile, EST_START } from '../src/plan.js';
import { estimatePlan, classifyStep, autoApproveVerdict, renderEstimate } from '../src/estimate.js';
import { evaluatePlan, parseCommands } from '../src/policy.js';
import { DEFAULT_CONFIG, merge } from '../src/config.js';
import { PLAN } from './helpers.js';

test('digest ignores frontmatter, estimate block and trailing whitespace, but not content', () => {
  const file = renderPlanFile({ id: 'x', title: 't', body: PLAN, estimateMd: '## Lake estimate\nfoo' });
  assert.ok(file.includes(EST_START));
  assert.equal(readPlanText(file).digest, digestOf(PLAN));
  assert.equal(digestOf(PLAN.replace(/\n/g, '   \r\n')), digestOf(PLAN));
  assert.notEqual(digestOf(PLAN.replace('bounded', 'unbounded')), digestOf(PLAN));
});

test('steps come from numbered lists, then headings, then bullets', () => {
  assert.equal(extractSteps(PLAN).length, 4);
  assert.deepEqual(extractSteps('# T\n## Context\nx\n## Build API\ny\n## Add tests\nz').map((s) => s.title), ['Build API', 'Add tests']);
  assert.deepEqual(extractSteps('- a\n- b').map((s) => s.title), ['a', 'b']);
  assert.equal(extractSteps('just do it').length, 1);
});

test('complexity and model per step', () => {
  assert.equal(classifyStep('Fix typo in README').complexity, 'low');
  assert.equal(classifyStep('Database migration for auth tokens').complexity, 'high');
  assert.equal(classifyStep('Add a retry queue').complexity, 'medium');
  const est = estimatePlan(PLAN, DEFAULT_CONFIG);
  assert.deepEqual(est.steps.map((s) => s.complexity), ['medium', 'high', 'low', 'medium']);
  assert.equal(est.steps[2].model, 'Claude Haiku 5.5');
  assert.equal(est.complexity, 'high');
  assert.ok(est.usd[0] > 0 && est.usd[0] < est.usd[1]);
  assert.ok(est.frontierUsd[1] > est.usd[1], 'routing per step should be cheaper than all-frontier');
  assert.match(renderEstimate(est, DEFAULT_CONFIG), /\| 3 \| Fix typo in README \| low \| Claude Haiku 5\.5 \|/);
});

test('auto-approve threshold', () => {
  const small = estimatePlan('1. Fix typo in README', DEFAULT_CONFIG);
  assert.equal(autoApproveVerdict(small, DEFAULT_CONFIG).eligible, true);
  const big = estimatePlan(PLAN, DEFAULT_CONFIG);
  const v = autoApproveVerdict(big, DEFAULT_CONFIG);
  assert.equal(v.eligible, false);
  assert.ok(v.reasons.length >= 2);
});

const plan = { id: 'add-webhook-retries', digest: digestOf(PLAN), short: digestOf(PLAN).slice(0, 8) };
const ev = (login, body, createdAt, o = {}) => ({ login, body, createdAt, type: o.type || 'User', association: o.association || 'MEMBER' });
const cfg = DEFAULT_CONFIG;

test('parses commands', () => {
  assert.deepEqual(parseCommands('LGTM\n/lake approve a@abcdef12\n/lake revoke b'), [{ action: 'approve', id: 'a', digest: 'abcdef12' }, { action: 'revoke', id: 'b', digest: null }]);
  assert.deepEqual(parseCommands('please /lake approve x@1234567'), []);
});

test('a non-author teammate approves the exact version', () => {
  const r = evaluatePlan({ plan, events: [ev('noah', `/lake approve ${plan.id}@${plan.short}`, '1')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved');
  assert.deepEqual(r.approvers, ['noah']);
});

test('author, bots, read-only users and stale versions cannot approve', () => {
  const line = `/lake approve ${plan.id}@${plan.short}`;
  const events = [ev('Maya', line, '1'), ev('claude[bot]', line, '2', { type: 'Bot' }), ev('drive-by', line, '3', { association: 'CONTRIBUTOR' }), ev('noah', `/lake approve ${plan.id}@deadbeef`, '4')];
  const r = evaluatePlan({ plan, events, prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'pending');
  assert.equal(r.notes.length, 4);
  assert.match(r.notes.join('\n'), /author cannot approve/);
  assert.match(r.notes.join('\n'), /edits invalidate approval/);
});

test('reject blocks until the same reviewer approves; revoke withdraws', () => {
  const ok = `/lake approve ${plan.id}@${plan.short}`;
  let r = evaluatePlan({ plan, events: [ev('noah', ok, '1'), ev('lior', `/lake reject ${plan.id}@${plan.short}`, '2')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'changes-requested');
  r = evaluatePlan({ plan, events: [ev('noah', ok, '1'), ev('lior', `/lake reject ${plan.id}@${plan.short}`, '2'), ev('lior', ok, '3')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved');
  r = evaluatePlan({ plan, events: [ev('noah', ok, '1'), ev('noah', `/lake revoke ${plan.id}`, '2')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'pending');
});

test('requiredApprovals and auto-approve modes', () => {
  const two = merge(cfg, { requiredApprovals: 2 });
  const r = evaluatePlan({ plan, events: [ev('noah', `/lake approve ${plan.id}@${plan.short}`, '1')], prAuthor: 'maya', config: two });
  assert.equal(r.state, 'pending'); assert.equal(r.needed, 1);
  const small = { id: 's', digest: digestOf('1. Fix typo'), short: digestOf('1. Fix typo').slice(0, 8) };
  const est = estimatePlan('1. Fix typo', cfg);
  assert.equal(evaluatePlan({ plan: small, estimate: est, events: [], prAuthor: 'maya', config: cfg }).state, 'pending'); // shadow by default
  assert.equal(evaluatePlan({ plan: small, estimate: est, events: [], prAuthor: 'maya', config: merge(cfg, { autoApprove: { mode: 'on' } }) }).state, 'auto-approved');
});

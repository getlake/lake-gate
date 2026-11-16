import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../src/config-core.js';
import { readPlanText, renderPlanFile } from '../src/plan.js';
import { estimatePlan } from '../src/estimate.js';
import { evaluatePlan, isPassing } from '../src/policy.js';
import { resolveModel, declarations, costSuggestions, applyPatch, modelOptions } from '../src/models.js';
import { buildPlanReview, versionsFromSnapshots, suggestionBody, acceptBody } from '../src/review.js';
import { client, evaluatePr, renderSummary } from '../src/github.js';
import { patchPlanFile } from '../src/workspace.js';
import { createContext, callTool, TOOLS } from '../src/mcp.js';
import { tmpRepo, fakeGitHub, comment } from './helpers.js';

const BIG = `# Move ledger to double-entry

Model: fable

1. Add a \`ledger_entries\` table with a migration and backfill all historical charges
2. Rewrite the balance service to read from ledger entries (concurrency and locking)
3. Rename the old balance columns
4. Update the README (optional)
`;
const cfg = parseConfig(JSON.stringify({ requiredApprovals: 1, budget: { approverAbove: 20, approvers: ['dana'] } }));

test('models: names, aliases and tiers resolve; plan and step declarations are part of the plan text', () => {
  assert.equal(resolveModel('Opus', cfg).key, 'claude-opus-5-5');
  assert.equal(resolveModel('claude-sonnet-5-5', cfg).key, 'claude-sonnet-5-5');
  assert.equal(resolveModel('Sonnet 5.5', cfg).key, 'claude-sonnet-5-5');
  assert.equal(resolveModel('balanced', cfg).key, 'claude-sonnet-5-5');
  assert.equal(resolveModel('GPT-6.1 Sol', cfg).key, 'gpt-6.1-sol');
  assert.equal(resolveModel('nope-9', cfg), null);
  assert.deepEqual(declarations('# T\n\n**Model:** Sonnet 5.5\nBudget cap: $12\n'), { model: 'Sonnet 5.5', cap: 12 });
  const a = readPlanText(BIG); const b = readPlanText(BIG.replace('Model: fable', 'Model: sonnet'));
  assert.notEqual(a.digest, b.digest, 'changing the model is a new version');
  const est = estimatePlan(BIG.replace('3. Rename the old balance columns', '3. Rename the old balance columns (model: haiku)'), cfg);
  assert.equal(est.model.key, 'claude-fable-5-2');
  assert.equal(est.steps[2].planned.key, 'claude-haiku-5-5');
  assert.equal(est.steps[2].planned.source, 'step');
  assert.equal(est.steps[2].title, 'Rename the old balance columns');
  assert.ok(est.plannedUsd[1] > est.usd[1], 'Fable costs more than the Lake mix');
  assert.equal(est.steps[3].optional, true);
  const unk = estimatePlan('# X\n\nModel: wizard-1\n\n1. Do a thing\n', cfg);
  assert.match(unk.modelNotes[0], /Unknown model "wizard-1"/);
});

test('model options: Lake mix first, then by cost, with a quality fit', () => {
  const opts = modelOptions(estimatePlan(BIG, cfg), cfg);
  assert.equal(opts[0].key, 'lake-mix');
  assert.ok(opts.slice(1).every((o, i, a) => i === 0 || a[i - 1].usd[1] <= o.usd[1]));
  assert.equal(opts.find((o) => o.key === 'claude-haiku-5-5').fit, 'risky');
  assert.equal(opts.find((o) => o.key === 'claude-fable-5-2').fit, 'overkill');
  assert.equal(opts.find((o) => o.key === 'claude-opus-5-5').fit, 'good');
});

test('cost suggestions apply as plan edits: cheaper step models, drop optional step, cap', () => {
  const est = estimatePlan(BIG, cfg);
  const s = costSuggestions(est, cfg);
  const kinds = s.map((x) => x.kind);
  assert.deepEqual(kinds, ['model', 'drop', 'cap']);
  assert.ok(s.every((x) => x.saving[1] > 0));
  const body = readPlanText(BIG).body;
  const m = applyPatch(body, s[0].patch);
  assert.match(m, /Rewrite the balance service.*\(model: Opus 5\.5\)/);
  assert.match(m, /Rename the old balance columns \(model: Haiku 5\.5\)/);
  const after = estimatePlan(m, cfg);
  assert.ok(after.plannedUsd[1] < est.plannedUsd[1]);
  const d = applyPatch(body, s[1].patch);
  assert.doesNotMatch(d, /README/);
  const c = applyPatch(body, s[2].patch);
  assert.equal(declarations(c).cap, s[2].patch.usd);
  assert.equal(estimatePlan(c, cfg).exposure, s[2].patch.usd);
  const pm = applyPatch(m, { type: 'planModel', model: 'Sonnet 5.5' });
  assert.match(pm, /^Model: Sonnet 5\.5$/m);
  assert.doesNotMatch(pm, /\(model:/, 'plan-level model clears step overrides');
  const noModel = applyPatch('# T\n\n1. Fix typo\n', { type: 'planModel', model: 'Haiku 5.5' });
  assert.equal(noModel, '# T\n\nModel: Haiku 5.5\n\n1. Fix typo\n');
  const two = applyPatch('# T\n\n1. A step\n2. Optional docs (optional)\n3. Last step\n', { type: 'dropStep', n: 2, title: 'Optional docs (optional)' });
  assert.equal(two, '# T\n\n1. A step\n2. Last step\n', 'renumbers');
});

test('budget approval: above the threshold one budget approver must approve this exact version', () => {
  const plan = readPlanText(BIG); const est = estimatePlan(plan.body, cfg);
  const ev = (login, body, at) => ({ login, type: 'User', association: 'MEMBER', body, createdAt: at });
  const ok = `/lake approve ${plan.id || 'x'}@${plan.short}`;
  plan.id = 'ledger';
  const ap = (l, at, v = plan.short) => ev(l, `/lake approve ledger@${v}`, at);
  let r = evaluatePlan({ plan, estimate: est, events: [ap('noah', '1')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'needs-budget');
  assert.equal(r.budget.required, true);
  assert.equal(isPassing(r), false);
  r = evaluatePlan({ plan, estimate: est, events: [ap('noah', '1'), ap('dana', '2')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved'); assert.deepEqual(r.budget.approvedBy, ['dana']);
  r = evaluatePlan({ plan, estimate: est, events: [ap('dana', '2')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved', 'the budget owner also counts as a reviewer');
  r = evaluatePlan({ plan, estimate: est, events: [ap('noah', '1'), ap('dana', '2', 'deadbeef')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'needs-budget', 'budget approval is version-bound');
  r = evaluatePlan({ plan, estimate: est, events: [ap('noah', '1')], prAuthor: 'dana', config: cfg });
  assert.equal(r.state, 'needs-budget', 'the author cannot budget-approve their own plan');
  const cheap = { ...readPlanText('# Fix typo\n\nModel: haiku\n\n1. Fix typo in README\n'), id: 'typo' };
  r = evaluatePlan({ plan: cheap, estimate: estimatePlan(cheap.body, cfg), events: [ev('noah', `/lake approve ${cheap.id}@${cheap.short}`, '1')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved'); assert.equal(r.budget.required, false);
  const capped = readPlanText(applyPatch(BIG, { type: 'cap', usd: 15 }));
  r = evaluatePlan({ plan: { ...capped, id: 'ledger' }, estimate: estimatePlan(capped.body, cfg), events: [ev('noah', `/lake approve ledger@${capped.short}`, '1')], prAuthor: 'maya', config: cfg });
  assert.equal(r.state, 'approved', 'a cap under the threshold removes the budget step');
  void ok;
});

test('review model: reviewer suggestion threads, one-click accept creates a new round', () => {
  const t1 = renderPlanFile({ id: 'ledger', title: 'Move ledger', body: BIG, estimateMd: '' });
  const v1 = versionsFromSnapshots([{ text: t1 }], 'ledger')[0];
  const sbody = suggestionBody({ planId: 'ledger', version: v1.digest, title: 'Run the plan on Opus 5.5', patch: { type: 'planModel', model: 'Opus 5.5' }, saving: [1, 9], text: 'Fable is overkill here.', thread: 'sg1', via: 'Lake review' });
  assert.match(sbody, /\*\*Suggestion on `ledger`/);
  const t2 = patchPlanFile(t1, { type: 'planModel', model: 'Opus 5.5' }, cfg);
  assert.match(t2, /^Model: Opus 5\.5$/m); assert.match(t2, /lake:estimate:start/);
  const v2 = versionsFromSnapshots([{ text: t2 }], 'ledger')[0];
  const events = [
    { id: 'a', source: 'comment', login: 'noah', type: 'User', association: 'MEMBER', body: sbody, createdAt: '2026-11-16T08:00:00Z' },
  ];
  let m = buildPlanReview({ plan: v1, versions: [v1], events, prAuthor: 'maya', config: cfg, pr: { number: 1, state: 'open' } });
  const th = m.threads.find((t) => t.id === 'sg1');
  assert.equal(th.suggestion.title, 'Run the plan on Opus 5.5');
  assert.equal(th.comments[0].text, 'Fable is overkill here.');
  assert.ok(m.suggestions.length >= 1); assert.ok(m.modelOptions.length > 3);
  assert.equal(m.budget.required, true);
  assert.ok(m.reviewers.find((r) => r.login === 'dana' && r.budget), 'budget approver listed as reviewer');
  events.push({ id: 'b', source: 'comment', login: 'maya', type: 'User', association: 'MEMBER', body: acceptBody({ planId: 'ledger', thread: 'sg1', title: th.suggestion.title, newVersion: v2.digest, via: 'Lake review' }), createdAt: '2026-11-16T08:05:00Z' });
  m = buildPlanReview({ plan: v2, versions: [v1, v2], events, prAuthor: 'maya', config: cfg, pr: { number: 1, state: 'open' } });
  const th2 = m.threads.find((t) => t.id === 'sg1');
  assert.equal(th2.suggestion.accepted, true); assert.equal(th2.resolved, true);
  assert.equal(m.round, 2);
  assert.ok(m.timeline.some((t) => t.kind === 'accept'));
});

test('GitHub summary and status: budget line, needs-budget failure, suggestions', async () => {
  const text = renderPlanFile({ id: 'ledger', title: 'Move ledger', body: BIG, estimateMd: '' });
  const plan = readPlanText(text);
  const gh0 = fakeGitHub({ files: ['.lake/plans/ledger.md', 'src/a.js'], contents: { '.lake/plans/ledger.md': text }, baseConfig: JSON.stringify({ budget: { approverAbove: 20, approvers: ['dana'] } }),
    comments: [comment('noah', `/lake approve ledger@${plan.short}`, '2026-11-16T08:00:00Z')] });
  const gh = client({ token: 't', repo: 'acme/app', fetchImpl: gh0.fetchImpl });
  const ev = await evaluatePr(gh, 7);
  assert.equal(ev.state, 'failure');
  assert.match(ev.description, /Needs budget approval for ledger/);
  const md = renderSummary(ev);
  assert.match(md, /\*\*Budget approval\*\* for `ledger`/);
  assert.match(md, /@dana must approve/);
  assert.match(md, /Lake can cut `ledger`/);
  assert.match(md, /on Fable 5\.2/);
});

test('MCP: lake_cost, lake_apply_suggestion locally, lake_suggest on the PR', async () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['lake_request_review', 'lake_review_status', 'lake_submit_revision', 'lake_review']);
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, '.lake'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.lake', 'config.json'), JSON.stringify({ budget: { approverAbove: 20, approvers: ['dana'] } }));
  const ctx = createContext({ root: dir, prNumber: null });
  ctx.pr = async () => null;
  const { exportPlan } = await import('../src/store.js');
  exportPlan(dir, BIG, { id: 'ledger' });
  const out = await callTool(ctx, 'lake_cost', { plan_id: 'ledger' });
  assert.match(out, /Model options/); assert.match(out, /\[models-/); assert.match(out, /Budget approval: up to/);
  const id = out.match(/\[(models-[\d-]+)\]/)[1];
  const res = await callTool(ctx, 'lake_apply_suggestion', { plan_id: 'ledger', suggestion_id: id });
  assert.match(res, /new version v[0-9a-f]{8}/);
  assert.match(fs.readFileSync(path.join(dir, '.lake/plans/ledger.md'), 'utf8'), /\(model: Opus 5\.5\)/);
  const res2 = await callTool(ctx, 'lake_apply_suggestion', { plan_id: 'ledger', model: 'sonnet' });
  assert.match(fs.readFileSync(path.join(dir, '.lake/plans/ledger.md'), 'utf8'), /^Model: Sonnet 5\.5$/m);
  assert.match(res2, /Applied "Run the plan on Sonnet 5\.5"/);

  const text = renderPlanFile({ id: 'ledger', title: 'Move ledger', body: BIG, estimateMd: '' });
  const g = fakeGitHub({ files: ['.lake/plans/ledger.md'], contents: { '.lake/plans/ledger.md': text } });
  const gh = client({ token: 't', repo: 'acme/app', fetchImpl: async (u, o) => {
    const p = new URL(u).pathname;
    if (/\/pulls\/7\/(commits|comments)$/.test(p)) return { ok: true, status: 200, json: async () => (new URL(u).searchParams.get('page') === '1' && p.endsWith('commits') ? [{ sha: 'headsha', commit: {} }] : []), text: async () => '' };
    if (o.method === 'POST' && p.endsWith('/issues/7/comments')) { g.calls.push({ m: 'POST', p: '/issues/7/comments', body: JSON.parse(o.body) }); return { ok: true, status: 201, json: async () => ({ id: 5, user: { login: 'noah', type: 'User' }, author_association: 'MEMBER', body: '', created_at: '' }), text: async () => '' }; }
    if (p.endsWith('/commits')) return { ok: true, status: 200, json: async () => [{ sha: 'headsha' }], text: async () => '' };
    return g.fetchImpl(u, o);
  } });
  const ctx2 = createContext({ root: dir, gh, prNumber: 7 });
  const r = await callTool(ctx2, 'lake_suggest', { plan_id: 'ledger', model: 'opus', comment: 'Fable is overkill' });
  assert.match(r, /Suggested on PR #7: Run the plan on Opus 5\.5/);
  const posted = g.calls.find((c) => c.m === 'POST' && c.p === '/issues/7/comments');
  assert.match(posted.body.body, /lake:c .*"s":\{"title":"Run the plan on Opus 5.5"/);
});

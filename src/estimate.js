import { normalizeBody } from './plan.js';
import { analyzePlan, scoreStep, PRICES } from './meter-core.js';
import { applyDeclarations } from './models.js';

const RANK = { low: 0, medium: 1, high: 2 };
export const complexityRank = (c) => RANK[c] ?? 1;

// Kept for callers of 0.1: classify one step with the shared scorer.
export function classifyStep(text) {
  const { complexity, reasons } = scoreStep({ title: text, body: '' });
  return { complexity: levelToComplexity(complexity), level: complexity, reasons };
}

// One estimator for all Lake tools: steps, complexity 1-5, model picks and prices come from lake-meter's
// analyzePlan and price table (src/meter-core.js). complexity keeps the low/medium/high label for policy;
// level is the 1-5 score.
export const levelToComplexity = (n) => (n <= 2 ? 'low' : n === 3 ? 'medium' : 'high');
export function pricesFor(config) {
  const extra = config.catalog || {};
  return Object.keys(extra).length ? { ...PRICES, models: { ...PRICES.models, ...extra } } : PRICES;
}
export function estimatePlan(body, config) {
  const prices = pricesFor(config);
  const a = analyzePlan(normalizeBody(body), prices, { provider: config.provider || 'anthropic' });
  const steps = a.steps.map((s) => ({ n: s.n, title: s.title.replace(/\s*[([]\s*model\s*:\s*[^)\]]+[)\]]/i, '').slice(0, 90), complexity: levelToComplexity(s.complexity), level: s.complexity, reasons: s.reasons, tier: s.tier,
    model: s.modelLabel, modelKey: s.model, tokens: prices.assumptions.stepTokens[String(s.complexity)], usd: s.usd, frontierUsd: s.baselineUsd }));
  const maxC = steps.reduce((m, s) => (complexityRank(s.complexity) > complexityRank(m) ? s.complexity : m), 'low');
  return applyDeclarations({
    steps,
    complexity: maxC,
    usd: a.total.usd,
    frontierUsd: a.total.baselineUsd,
    baseline: a.baselineLabel,
    pricesAsOf: a.pricesVerifiedAt,
  }, body, config);
}

export const money = (n) => (n < 0.01 ? '<$0.01' : n < 0.1 ? `$${n.toFixed(3)}` : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
export const range = ([a, b]) => (b < 0.01 ? '<$0.01' : `${money(a)}–${money(b)}`);
// Which model the cost is for: one plan model, or per-step picks on top of a default.
export const mixedModels = (est) => !!est.declared && est.steps.some((s) => s.planned && s.planned.name !== est.model?.name);
export const modelLabel = (est) => (mixedModels(est) ? (est.model ? ` · planned per step (default ${est.model.name})` : ' · planned per step') : est.model ? ` on ${est.model.name}` : '');
export const costLabel = (est) => `${range(est.declared ? est.plannedUsd : est.usd)}${modelLabel(est)}`;

export function autoApproveVerdict(est, config) {
  const a = config.autoApprove || {};
  if (!a.mode || a.mode === 'off') return { eligible: false, mode: 'off', reasons: [] };
  const reasons = [];
  const top = est.exposure ?? est.usd[1];
  if (top > a.maxUsd) reasons.push(`upper estimate ${money(top)} > ${money(a.maxUsd)}`);
  if (config.budget?.approverAbove != null && top > config.budget.approverAbove) reasons.push('needs budget approval');
  if (est.steps.length > a.maxSteps) reasons.push(`${est.steps.length} steps > ${a.maxSteps}`);
  if (complexityRank(est.complexity) > complexityRank(a.maxComplexity)) reasons.push(`complexity ${est.complexity} > ${a.maxComplexity}`);
  return { eligible: reasons.length === 0, mode: a.mode, reasons };
}

export function renderEstimate(est, config) {
  const rows = est.steps.map((s) => `| ${s.n} | ${s.title.replace(/\|/g, '/')} | ${s.complexity} | ${est.declared ? `${s.planned ? `${s.planned.name}${s.fit === 'risky' ? ' (may be too weak)' : ''}` : 'not set'} | ` : ''}${s.model} | ${range(s.planned ? s.planned.usd : s.usd)} |`);
  const auto = autoApproveVerdict(est, config);
  const autoLine = auto.mode === 'off' ? '' : auto.eligible
    ? `\nAuto-approve policy (${auto.mode}): ${auto.mode === 'on' ? 'this plan is auto-approved' : 'this plan would be auto-approved'} (small, low cost).`
    : `\nAuto-approve policy (${auto.mode}): needs a human (${auto.reasons.join('; ')}).`;
  return [
    '## Lake estimate',
    '',
    `Overall complexity: **${est.complexity}** · ${est.declared ? `${mixedModels(est) ? `Planned per step${est.model ? ` (default **${est.model.name}**)` : ''}` : `Planned model${est.model ? ` **${est.model.name}**` : 's per step'}`}: **${range(est.plannedUsd)}** · Lake mix (cheapest model that fits each step): ${range(est.usd)}` : `Estimated cost with the recommended model per step: **${range(est.usd)}** (all steps on ${est.baseline}: ${range(est.frontierUsd)})`}${est.cap != null ? ` · Budget cap **${money(est.cap)}**` : ''}`,
    '',
    est.declared ? '| # | Step | Complexity | Planned model | Recommended model | Est. cost |' : '| # | Step | Complexity | Recommended model | Est. cost |',
    est.declared ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|',
    ...rows,
    '',
    `Same estimator and price table as lake-meter (API list prices as of ${est.pricesAsOf}). Not a quote. Subscription plans spend quota, not these dollars.` + autoLine,
  ].join('\n');
}

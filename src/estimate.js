import { extractSteps } from './plan.js';

const RANK = { low: 0, medium: 1, high: 2 };
export const complexityRank = (c) => RANK[c] ?? 1;

const HIGH = /\b(migrat\w*|schema|database|auth\w*|security|secret|payment|billing|concurren\w*|race|lock(ing)?|distributed|encrypt\w*|permission\w*|architect\w*|rewrite|re-?architect|multi-?tenant|infra\w*|deploy\w*|kubernetes|cache invalidation|backfill|data model|breaking change)\b/i;
const LOW = /\b(typo|rename|copy|wording|docs?|readme|comment|bump|version bump|lint|format\w*|style|log message|changelog|config value|constant|label|tooltip|text)\b/i;
const MANY_FILES = /\b(across|all|every|each)\s+(the\s+)?(files|modules|services|packages|endpoints|components|call ?sites)\b/i;
const TESTS = /\b(test|tests|spec|e2e|integration)\b/i;

export function classifyStep(text) {
  const reasons = [];
  let score = 1;
  const h = text.match(HIGH); const l = text.match(LOW);
  if (h) { score += 1; reasons.push(`mentions "${h[0]}"`); }
  if (MANY_FILES.test(text)) { score += 1; reasons.push('touches many files'); }
  if (l && !h) { score -= 1; reasons.push(`looks small ("${l[0]}")`); }
  const words = text.split(/\s+/).length;
  if (words > 80) { score += 1; reasons.push('long step'); }
  if (TESTS.test(text) && score < 2 && !l) reasons.push('includes tests');
  const complexity = score <= 0 ? 'low' : score === 1 ? 'medium' : 'high';
  if (!reasons.length) reasons.push('default');
  return { complexity, reasons };
}

const usd = (tokIn, tokOut, m, hit) => (tokIn * (1 - hit) * m.inputPerMTok + tokIn * hit * m.cacheReadPerMTok + tokOut * m.outputPerMTok) / 1e6;

export function estimatePlan(body, config) {
  const steps = extractSteps(body).map((s, i) => {
    const { complexity, reasons } = classifyStep(s.text);
    const tier = config.tierFor[complexity];
    const model = config.models[tier];
    const band = config.tokens[complexity];
    const hit = config.cacheHitShare;
    const lo = usd(band.in[0], band.out[0], model, hit);
    const hi = usd(band.in[1], band.out[1], model, hit);
    const top = config.models.frontier;
    return { n: i + 1, title: s.title.slice(0, 90), complexity, reasons, tier, model: model.name, tokens: band,
      usd: [lo, hi], frontierUsd: [usd(band.in[0], band.out[0], top, hit), usd(band.in[1], band.out[1], top, hit)] };
  });
  const sum = (k, i) => steps.reduce((a, s) => a + s[k][i], 0);
  const maxC = steps.reduce((a, s) => (complexityRank(s.complexity) > complexityRank(a) ? s.complexity : a), 'low');
  return {
    steps,
    complexity: maxC,
    usd: [sum('usd', 0), sum('usd', 1)],
    frontierUsd: [sum('frontierUsd', 0), sum('frontierUsd', 1)],
    pricesAsOf: config.pricesAsOf,
  };
}

export const money = (n) => (n < 0.1 ? `$${n.toFixed(3)}` : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
export const range = ([a, b]) => `${money(a)}–${money(b)}`;

export function autoApproveVerdict(est, config) {
  const a = config.autoApprove || {};
  if (!a.mode || a.mode === 'off') return { eligible: false, mode: 'off', reasons: [] };
  const reasons = [];
  if (est.usd[1] > a.maxUsd) reasons.push(`upper estimate ${money(est.usd[1])} > ${money(a.maxUsd)}`);
  if (est.steps.length > a.maxSteps) reasons.push(`${est.steps.length} steps > ${a.maxSteps}`);
  if (complexityRank(est.complexity) > complexityRank(a.maxComplexity)) reasons.push(`complexity ${est.complexity} > ${a.maxComplexity}`);
  return { eligible: reasons.length === 0, mode: a.mode, reasons };
}

export function renderEstimate(est, config) {
  const rows = est.steps.map((s) => `| ${s.n} | ${s.title.replace(/\|/g, '/')} | ${s.complexity} | ${s.model} | ${range(s.usd)} |`);
  const auto = autoApproveVerdict(est, config);
  const autoLine = auto.mode === 'off' ? '' : auto.eligible
    ? `\nAuto-approve policy (${auto.mode}): ${auto.mode === 'on' ? 'this plan is auto-approved' : 'this plan would be auto-approved'} (small, low cost).`
    : `\nAuto-approve policy (${auto.mode}): needs a human (${auto.reasons.join('; ')}).`;
  return [
    '## Lake estimate',
    '',
    `Overall complexity: **${est.complexity}** · Estimated cost with the recommended model per step: **${range(est.usd)}** (all steps on ${config.models.frontier.name}: ${range(est.frontierUsd)})`,
    '',
    '| # | Step | Complexity | Recommended model | Est. cost |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `Rough forecast from keyword heuristics and API list prices as of ${est.pricesAsOf}, assuming ${Math.round(config.cacheHitShare * 100)}% cache hits. Not a quote, not a cap. Subscription plans spend quota, not these dollars.` + autoLine,
  ].join('\n');
}

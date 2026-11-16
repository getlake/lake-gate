// Model choice, cost-cutting suggestions and budget exposure for a plan. Pure and browser-safe.
// A plan declares its model in the plan text, so the choice is part of the approved version:
//   Model: sonnet-5.5            (whole plan; also "**Model:** Opus 5.5" or "Agent: Claude Code · Model: opus")
//   3. Rename the flag (model: haiku)   (one step)
//   Budget cap: $12              (the run stops here; budget approval looks at the cap, not the upper estimate)
// Steps marked "(optional)" can be dropped by a suggestion.
import { stripEstimate, normalizeBody } from './plan.js';
import { splitPlan, costOfBudget, resolveModel as meterResolve } from './meter-core.js';
import { pricesFor } from './estimate.js';

// Models and prices come from the shared Lake price table (lake-meter's prices.json, see meter-core.js).
// quality by tier: light 2, standard 3, heavy 4, frontier 5. A step of complexity level n needs NEED_LEVEL[n].
const QUALITY = { light: 2, standard: 3, heavy: 4, frontier: 5 };
const NEED_LEVEL = { 1: 2, 2: 2, 3: 3, 4: 4, 5: 4 };
export const NEED = { low: 2, medium: 3, high: 4 };
const need = (s) => NEED_LEVEL[s.level] ?? NEED[s.complexity];
const TIER_ALIAS = { fast: 'light', light: 'light', balanced: 'standard', standard: 'standard', frontier: 'heavy', heavy: 'heavy', max: 'frontier' };
// Current models shown as options (older ones still resolve and price).
const CURRENT = (prices) => [...new Set(Object.values(prices.recommend || {}).flatMap((r) => Object.values(r)))];

export function catalogOf(config) {
  const prices = pricesFor(config);
  const out = {};
  for (const [k, m] of Object.entries(prices.models)) out[k] = { ...m, name: m.label || k, quality: m.quality ?? QUALITY[m.tier] ?? 3 };
  return out;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[`*_]/g, '').replace(/^claude[\s-]+/, '').trim();
export function resolveModel(text, config) {
  const q = norm(text); if (!q) return null;
  const prices = pricesFor(config); const cat = catalogOf(config);
  const hit = (k) => (k && cat[k] ? { key: k, ...cat[k] } : null);
  if (cat[text]) return hit(text);
  if (TIER_ALIAS[q]) return hit(prices.recommend[config.provider || 'anthropic'][TIER_ALIAS[q]]);
  for (const [k, m] of Object.entries(cat)) if (norm(m.name) === q || norm(m.alias) === q) return hit(k);
  return hit(meterResolve(q.replace(/\s+/g, '-'), prices));
}
export function recommendedKey(level, config) {
  const prices = pricesFor(config);
  const lv = typeof level === 'number' ? level : { low: 2, medium: 3, high: 4 }[level] || 3;
  return prices.recommend[config.provider || 'anthropic'][prices.assumptions.complexityToTier[String(lv)]];
}
// Cost of one step's token budget on a model, the same way lake-meter prices it.
function stepUsd(s, key, prices) {
  const b = prices.assumptions.stepTokens[String(s.level)] || prices.assumptions.stepTokens['3'];
  const mult = prices.assumptions.tierTokenMultiplier[prices.models[key].tier] ?? 1;
  return [0, 1].map((i) => costOfBudget(key, b.input[i] * mult, b.output[i] * mult, prices));
}
const NAME_OF = (key, config) => catalogOf(config)[key]?.name || key;

const PLAN_MODEL = /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:agent\s*[^\n]*?·\s*)?model(?:\*\*)?\s*:(?:\*\*)?\s*(.+?)\s*$/im;
const STEP_MODEL = /\s*[([]\s*model\s*:\s*([^)\]]+)[)\]]/i;
const CAP = /^\s*(?:[-*>]\s*)?(?:\*\*)?budget\s*cap(?:\*\*)?\s*:(?:\*\*)?\s*\$?\s*([\d.,]+)/im;
const OPTIONAL = /\((?:optional|nice to have)\)|\boptional:/i;

export function declarations(body) {
  const b = stripEstimate(String(body));
  const pm = b.match(PLAN_MODEL);
  const cap = b.match(CAP);
  return { model: pm ? pm[1].replace(/\*+$/, '').trim() : null, cap: cap ? Number(cap[1].replace(/,/g, '')) : null };
}
export function stepModelTag(text) { const m = String(text).match(STEP_MODEL); return m ? m[1].trim() : null; }
export const isOptionalStep = (text) => OPTIONAL.test(String(text));


// Adds the declared model per step and its cost to an estimate from estimatePlan.
export function applyDeclarations(est, body, config) {
  const d = declarations(body);
  const planModel = d.model ? resolveModel(d.model, config) : null;
  const notes = [];
  if (d.model && !planModel) notes.push(`Unknown model "${d.model}". Add it to "catalog" in .lake/config.json to price it.`);
  const prices = pricesFor(config); const cat = catalogOf(config);
  const raw = splitPlan(normalizeBody(body)).map((x) => ({ text: `${x.title}\n${x.body || ''}` }));
  const steps = est.steps.map((s, i) => {
    const tag = stepModelTag(raw[i]?.text || '');
    const tagged = tag ? resolveModel(tag, config) : null;
    if (tag && !tagged) notes.push(`Step ${s.n}: unknown model "${tag}".`);
    const m = tagged || planModel;
    const rec = s.modelKey || recommendedKey(s.level, config);
    const planned = m ? { key: m.key, name: m.name, quality: m.quality, usd: stepUsd(s, m.key, prices), source: tagged ? 'step' : 'plan' } : null;
    const fit = !m ? 'ok' : m.quality < need(s) ? 'risky' : m.quality > (cat[rec]?.quality ?? 9) ? 'overkill' : 'ok';
    return { ...s, recommendedKey: rec, planned, fit, optional: isOptionalStep(raw[i]?.text || ''), title: s.title.replace(STEP_MODEL, '').trim() };
  });
  const sum = (i) => steps.reduce((a, s) => a + (s.planned ? s.planned.usd[i] : s.usd[i]), 0);
  const plannedUsd = [sum(0), sum(1)];
  const declared = steps.some((s) => s.planned);
  const exposure = d.cap != null ? Math.min(d.cap, plannedUsd[1]) : plannedUsd[1];
  return { ...est, steps, model: planModel ? { key: planModel.key, name: planModel.name } : null, declared, plannedUsd, cap: d.cap, exposure, modelNotes: notes };
}

// Whole-plan options for the model picker: cost if every step ran on that model, and how it fits.
export function modelOptions(est, config) {
  const prices = pricesFor(config); const cat = catalogOf(config);
  const top = Math.max(2, ...est.steps.map(need));
  const keys = [...new Set([...CURRENT(prices), ...(est.model ? [est.model.key] : [])])].filter((k) => cat[k]);
  const opts = keys.map((key) => {
    const m = cat[key];
    const usd = [0, 1].map((i) => est.steps.reduce((a, s) => a + stepUsd(s, key, prices)[i], 0));
    const weak = est.steps.filter((s) => m.quality < need(s)).length;
    const fit = weak ? 'risky' : m.quality > top ? 'overkill' : 'good';
    const note = weak ? `${weak} step${weak > 1 ? 's' : ''} may need retries or a human fix` : fit === 'overkill' ? 'Top quality, pays for headroom you may not use' : top >= 4 ? 'Strong enough for the hard steps' : 'Enough for every step';
    return { key, name: m.name, provider: m.provider, quality: m.quality, usd, fit, note };
  });
  const mix = { key: 'lake-mix', name: 'Lake mix', provider: 'Per step', quality: null, usd: est.usd, fit: 'good', note: 'Cheapest model that fits each step', recommended: true };
  return [mix, ...opts.sort((a, b) => a.usd[1] - b.usd[1])];
}

// Cost-cutting suggestions. Each one has a machine-applicable patch (see applyPatch).
export function costSuggestions(est, config) {
  const b = config.budget || {};
  const out = [];
  const cat = catalogOf(config);
  const over = est.steps.filter((s) => s.planned && s.planned.quality > cat[s.recommendedKey].quality);
  if (over.length) {
    const saving = [0, 1].map((i) => over.reduce((a, s) => a + s.planned.usd[i] - s.usd[i], 0));
    out.push({ id: `models-${over.map((s) => s.n).join('-')}`, kind: 'model', title: over.length === 1 ? `Run step ${over[0].n} on ${cat[over[0].recommendedKey].name}` : over.length === est.steps.length ? 'Use the Lake pick for each step' : `Cheaper models for ${over.length} simpler steps`,
      detail: over.map((s) => `${s.n}. ${s.title.slice(0, 40)}: ${s.planned.name} → ${cat[s.recommendedKey].name}`).join('\n'), saving,
      patch: { type: 'stepModels', steps: over.map((s) => ({ n: s.n, title: s.title, model: cat[s.recommendedKey].name })) } });
  }
  for (const s of est.steps.filter((x) => x.optional)) {
    const u = s.planned ? s.planned.usd : s.usd;
    out.push({ id: `drop-${s.n}`, kind: 'drop', title: `Drop optional step ${s.n}`, detail: s.title, saving: u, patch: { type: 'dropStep', n: s.n, title: s.title } });
  }
  const capAbove = b.suggestCapAbove ?? 10;
  if (est.cap == null && est.plannedUsd[1] > capAbove) {
    const mid = (est.plannedUsd[0] + est.plannedUsd[1]) / 2;
    const cap = Math.max(1, Math.ceil(mid * 1.15));
    if (cap < est.plannedUsd[1]) out.push({ id: `cap-${cap}`, kind: 'cap', title: `Cap the run at $${cap}`, detail: 'The agent stops and asks before spending more. Budget approval looks at the cap.', saving: [0, est.plannedUsd[1] - cap], patch: { type: 'cap', usd: cap } });
  }
  const min = b.suggestAbove ?? 0;
  return est.plannedUsd[1] >= min ? out.filter((s) => s.saving[1] > 0.005) : [];
}

// ---- Applying a patch to plan text (body without frontmatter) ----
const plain = (x) => String(x).replace(STEP_MODEL, '').replace(/[`*_]/g, '').trim();
function stepLine(lines, title) {
  const t = plain(title).slice(0, 50);
  return lines.findIndex((l) => /^\s{0,3}(\d+[.)]|[-*]|#{2,4})\s+/.test(l) && plain(l).includes(t));
}
export function setPlanModel(body, key) {
  const lines = String(body).split('\n');
  const i = lines.findIndex((l) => PLAN_MODEL.test(l) && !/^\s{0,3}\d+[.)]/.test(l));
  const line = `Model: ${key}`;
  if (i >= 0) lines[i] = line;
  else { const h = lines.findIndex((l) => /^#\s+/.test(l)); lines.splice(h + 1, 0, '', line); }
  // a plan-level choice replaces per-step overrides
  return lines.map((l) => (/^\s{0,3}(\d+[.)]|[-*])\s+/.test(l) ? l.replace(STEP_MODEL, '') : l)).join('\n').replace(/\n{3,}/g, '\n\n');
}
export function applyPatch(body, patch) {
  const lines = String(body).split('\n');
  if (patch.type === 'planModel') return setPlanModel(body, patch.model);
  if (patch.type === 'stepModels') {
    for (const s of patch.steps) { const i = stepLine(lines, s.title); if (i >= 0) lines[i] = `${lines[i].replace(STEP_MODEL, '').replace(/\s+$/, '')} (model: ${s.model})`; }
    return lines.join('\n');
  }
  if (patch.type === 'cap') {
    const i = lines.findIndex((l) => CAP.test(l));
    if (i >= 0) lines[i] = `Budget cap: $${patch.usd}`;
    else { const m = lines.findIndex((l) => PLAN_MODEL.test(l)); const h = m >= 0 ? m : lines.findIndex((l) => /^#\s+/.test(l)); lines.splice(h + 1, 0, ...(m >= 0 ? [] : ['']), `Budget cap: $${patch.usd}`); }
    return lines.join('\n');
  }
  if (patch.type === 'dropStep') {
    const i = stepLine(lines, patch.title); if (i < 0) return body;
    let j = i + 1; while (j < lines.length && /^\s{2,}\S/.test(lines[j])) j++;
    lines.splice(i, j - i);
    { // renumber the rest of this list
      for (let k = i; k < lines.length; k++) {
        const m = lines[k].match(/^(\s{0,3})(\d+)([.)]\s+.*)$/);
        if (m) lines[k] = `${m[1]}${Number(m[2]) - 1}${m[3]}`; else if (!/^\s{2,}\S/.test(lines[k]) && lines[k].trim()) break;
      }
    }
    return lines.join('\n');
  }
  throw new Error(`Unknown patch type ${patch.type}`);
}
export function describePatch(patch, config) {
  const nm = (k) => NAME_OF(k, config);
  if (patch.type === 'planModel') return `Run the plan on ${nm(patch.model)}`;
  if (patch.type === 'stepModels') return patch.steps.length === 1 ? `Run step ${patch.steps[0].n} on ${nm(patch.steps[0].model)}` : `Cheaper models for steps ${patch.steps.map((s) => s.n).join(', ')}`;
  if (patch.type === 'cap') return `Cap the run at $${patch.usd}`;
  if (patch.type === 'dropStep') return `Drop step ${patch.n}`;
  return patch.type;
}

// ---- Budget approval ----
// config.budget = { approverAbove: 25, approvers: ['dana', '@acme/eng-managers'] }
export function budgetRule(est, config, resolvedApprovers) {
  const b = config.budget || {};
  if (b.approverAbove == null || !(b.approvers || []).length) return { required: false };
  const exposure = est.exposure ?? est.usd[1];
  const required = exposure > b.approverAbove;
  const list = resolvedApprovers || b.approvers.filter((x) => !String(x).includes('/')).map((x) => String(x).replace(/^@/, ''));
  return { required, threshold: b.approverAbove, exposure, approvers: list, teams: b.approvers.filter((x) => String(x).includes('/')) };
}

// lake-gate MCP server (stdio). Lets Claude Code, Cursor or any MCP client:
//   author side:   request review on a plan, wait for the verdict, read anchored feedback, submit a revision;
//   reviewer side: read a plan with its threads, reply, approve or request changes from the agent chat.
// Everything is read from and written to the PR (the single source of truth), with the GitHub token
// already on this machine (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). No Lake server.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot, loadPlan, getState, exportPlan, listPlans, localStatus } from './store.js';
import { client } from './github.js';
import { parseRemote, applyEvents } from './sync.js';
import { collectEvents, nativeDigests } from './github.js';
import { loadPr, actions, viewer, isPlanFile } from './workspace.js';
import { loadConfig, configWarning } from './config.js';
import { range, money, estimatePlan, costLabel, mixedModels } from './estimate.js';
import { costSuggestions, modelOptions, applyPatch, resolveModel, describePatch, budgetRule } from './models.js';
import { stripEstimate } from './plan.js';
import { acceptBody, statusLabel } from './review.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sh = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });

// Four tools, on purpose. Author side: request_review → review_status → submit_revision. Reviewer side: review.
export const TOOLS = [
  { name: 'lake_request_review', description: 'Save a plan (markdown) as a versioned lake-gate plan and ask teammates to review it on the PR. Returns the plan id, version, model and cost estimate, and the review link. Use after planning, before implementing. Tip: add a "Model: <name>" line to declare which model runs it.',
    inputSchema: S({ plan_markdown: str('Full plan in markdown. Omit to request review of an existing plan.'), plan_id: str('Plan id (defaults to the active plan, or derived from the title)'),
      reviewers: { type: 'array', items: { type: 'string' }, description: 'GitHub logins to request review from' }, note: str('Short note to reviewers'),
      push: { type: 'boolean', description: 'Commit only the plan file and push the current branch (so the PR shows this version)' } }), annotations: { openWorldHint: true } },
  { name: 'lake_review_status', description: 'Review state of a plan: status, verdicts with notes, open comment threads anchored to plan lines, reviewer suggestions, budget approval, and the model/cost view with Lake\'s cost-cutting suggestion ids. Works locally before a PR exists. Set wait_seconds to wait for a decision or new feedback. Also syncs approvals so the lake-gate hook opens once approved.',
    inputSchema: S({ plan_id: str('Plan id (defaults to the active plan)'), wait_seconds: { type: 'number', minimum: 0, maximum: 240, description: 'Wait up to this long for a change (polls every 20s)' } }), annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'lake_submit_revision', description: 'As the author, save a new plan version (earlier approvals no longer apply) and tell reviewers. Either pass the full revised plan_markdown, or apply a suggestion in one step: thread_id (a reviewer suggestion), suggestion_id (from lake_review_status) or model (run the whole plan on that model). Can also reply to threads and mark them resolved.',
    inputSchema: S({ plan_markdown: str('Full revised plan in markdown'), plan_id: str('Plan id (defaults to the active plan)'),
      thread_id: str('Accept this reviewer suggestion thread'), suggestion_id: str('Apply this Lake suggestion, e.g. models-2-4, cap-12, drop-5'), model: str('Run the whole plan on this model, e.g. sonnet'),
      addressed_threads: { type: 'array', items: { type: 'string' }, description: 'Thread ids this revision addresses (marked resolved)' },
      note: str('What changed, for reviewers'), push: { type: 'boolean', description: 'Commit only the plan file and push (default on when applying a suggestion)' } }), annotations: { openWorldHint: true } },
  { name: 'lake_review', description: 'As a reviewer, act on a plan PR: approve, request_changes, comment (optionally on lines), reply (in a thread) or suggest (a structured change the author accepts in one click: suggestion_id or model). approve and request_changes post as the human GitHub account on this machine: ONLY use them when the user explicitly said so in this conversation, and pass the exact version they saw.',
    inputSchema: S({ action: { type: 'string', enum: ['approve', 'request_changes', 'comment', 'reply', 'suggest'] }, plan_id: str('Plan id'), version: str('8-character version (approve / request_changes)'),
      text: str('Comment, reply, or verdict note (required for request_changes)'), line: { type: 'number', description: 'First plan line to anchor a comment' }, end_line: { type: 'number' },
      thread_id: str('Thread to reply in'), suggestion_id: str('Lake suggestion id to propose'), model: str('Propose running the plan on this model') }, ['action']), annotations: { openWorldHint: true } },
];
// Older tool names still work (not listed): lake_approve, lake_request_changes, lake_comment, lake_reply, lake_cost, lake_suggest, lake_apply_suggestion.
const ALIASES = {
  lake_approve: (a) => ['lake_review', { ...a, action: 'approve', text: a.comment }],
  lake_request_changes: (a) => ['lake_review', { ...a, action: 'request_changes', text: a.comment }],
  lake_comment: (a) => ['lake_review', { ...a, action: 'comment' }],
  lake_reply: (a) => ['lake_review', { ...a, action: 'reply' }],
  lake_suggest: (a) => ['lake_review', { ...a, action: 'suggest', text: a.comment }],
  lake_apply_suggestion: (a) => ['lake_submit_revision', a],
  lake_cost: (a) => ['lake_cost', a],
};

export function formatCost(est, config, sugg = costSuggestions(est, config), budget) {
  const L = [];
  L.push(`Cost: ${est.declared ? `${range(est.plannedUsd)} ${mixedModels(est) ? `with the models planned per step${est.model ? ` (default ${est.model.name})` : ''}` : `with the planned model${est.model ? ` (${est.model.name})` : 's'}`}` : `${range(est.usd)} with Lake's pick per step (no model declared; add a "Model: <name>" line)`}${est.cap != null ? `, capped at ${money(est.cap)}` : ''}.`);
  L.push('Steps:', ...est.steps.map((s) => `  ${s.n}. ${s.title.slice(0, 70)} · ${s.complexity} · ${s.planned ? s.planned.name + (s.fit === 'risky' ? ' (may be too weak)' : s.fit === 'overkill' ? ' (more than needed)' : '') : 'not set'} · Lake pick ${s.model} · ${range(s.planned ? s.planned.usd : s.usd)}`));
  L.push('Model options (whole plan):', ...modelOptions(est, config).slice(0, 7).map((o) => `  ${o.name}: ${range(o.usd)} · ${o.fit} · ${o.note}`));
  if (sugg.length) L.push('Suggestions:', ...sugg.map((x) => `  [${x.id}] ${x.title}, saves up to ${money(x.saving[1])}`));
  if (budget?.required) L.push(`Budget approval: up to ${money(budget.exposure)} > ${money(budget.threshold)}. ${budget.satisfied ? `Approved by @${budget.approvedBy.join(', @')}.` : `Needs one of ${budget.approvers.map((x) => '@' + x).join(', ')} to approve this version.`}`);
  for (const n of est.modelNotes || []) L.push(`Note: ${n}`);
  return L.join('\n');
}
function patchFor(a, est, config) {
  if (a.model) { const m = resolveModel(a.model, config); if (!m) throw new Error(`Unknown model ${a.model}`); return { title: `Run the plan on ${m.name}`, patch: { type: 'planModel', model: m.name }, saving: null }; }
  const s = costSuggestions(est, config).find((x) => x.id === a.suggestion_id);
  if (!s) throw new Error(`No suggestion ${a.suggestion_id}. Current ones: ${costSuggestions(est, config).map((x) => x.id).join(', ') || 'none'}`);
  return s;
}

// Context: repo root + lazily resolved GitHub client and PR. Tests inject gh/prNumber/sleep.
export function createContext({ root = repoRoot(), gh, prNumber, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clientName = 'MCP client', token } = {}) {
  const ctx = { root, sleep, clientName };
  ctx.github = () => {
    if (gh) return gh;
    const repo = parseRemote(sh('git', ['remote', 'get-url', 'origin'], root));
    if (!repo) throw new Error('No GitHub remote named origin.');
    const t = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || sh('gh', ['auth', 'token'], root);
    if (!t) throw new Error('Need GitHub access: set GITHUB_TOKEN or run `gh auth login`.');
    gh = client({ token: t, repo });
    return gh;
  };
  ctx.pr = async () => {
    if (prNumber) return prNumber;
    const g = ctx.github();
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const prs = await g.req('GET', `/pulls?state=open&head=${encodeURIComponent(`${g.owner}:${branch}`)}`);
    if (!prs || !prs.length) return null;
    prNumber = prs[0].number;
    return prNumber;
  };
  return ctx;
}

const reviewLink = (cfg, repo, pr, id, act) => (cfg.reviewUrl && repo && pr ? `${cfg.reviewUrl}#/pr/${repo}/${pr}/${encodeURIComponent(id)}${act ? `?do=${act}` : ''}` : null);

function resolveId(ctx, id) {
  const pid = id || getState(ctx.root).active;
  if (!pid) throw new Error('No plan id given and no active plan.');
  return pid;
}

// No plan named, for tools that act on the PR: the plan(s) on this branch's PR, then plans this branch changed,
// then the active plan. Several candidates and none is active: ask instead of guessing.
async function resolvePrPlanId(ctx, id) {
  if (id) return id;
  const active = getState(ctx.root).active;
  const pick = (ids, where) => {
    const u = [...new Set(ids)];
    if (u.length === 1) return u[0];
    if (u.length > 1) { if (u.includes(active)) return active; throw new Error(`${where} has ${u.length} plans: ${u.join(', ')}. Pass plan_id to pick one.`); }
    return null;
  };
  let number = null;
  try { number = await ctx.pr(); } catch { /* no remote or no token: local only */ }
  if (number) {
    const files = (await ctx.github().all(`/pulls/${number}/files`)) || [];
    const r = pick(files.filter((f) => isPlanFile(f.filename) && f.status !== 'removed').map((f) => f.filename.split('/').pop().slice(0, -3)), `PR #${number}`);
    if (r) return r;
  }
  const base = ['origin/HEAD', 'origin/main', 'origin/master'].map((b) => sh('git', ['merge-base', 'HEAD', b], ctx.root)).find(Boolean);
  const changed = [sh('git', ['diff', '--name-only', base || 'HEAD', '--', '.lake/plans'], ctx.root), sh('git', ['ls-files', '--others', '--exclude-standard', '--', '.lake/plans'], ctx.root)]
    .join('\n').split('\n').filter((f) => isPlanFile(f)).map((f) => f.split('/').pop().slice(0, -3)).filter((pid) => loadPlan(ctx.root, pid));
  return pick(changed, 'This branch') || resolveId(ctx, null);
}

function pushPlan(ctx, id, message) {
  const p = `.lake/plans/${id}.md`;
  sh('git', ['add', p], ctx.root);
  const c = sh('git', ['commit', '-m', message, '--only', p], ctx.root);
  const pushed = sh('git', ['push', '-u', 'origin', 'HEAD'], ctx.root);
  return c !== null && pushed !== null ? `Committed and pushed ${p}.` : `Could not commit/push ${p} automatically; commit and push it yourself.`;
}

async function prModel(ctx, id) {
  const number = await ctx.pr();
  if (!number) return { number: null, model: null };
  const r = await loadPr(ctx.github(), number);
  return { number, model: r.plans.find((p) => p.id === id) || null, config: r.config, events: r.events, pr: r.pr };
}

export function formatReview(m, { localDigest, link } = {}) {
  const L = [];
  L.push(`Plan ${m.id} · v${m.short} (round ${m.round}) · status: ${statusLabel(m.status)}${m.policy.needed && m.status === 'in-review' ? ` · needs ${m.policy.needed} more approval(s)` : ''}`);
  if (m.status === 'in-review' && m.policy.auto?.mode !== 'off' && m.policy.auto?.reasons?.length) L.push(`Not auto-approved: ${m.policy.auto.reasons.join('; ')}`);
  L.push(`Estimate: ${m.estimate.complexity} complexity, ${costLabel(m.estimate)}`);
  if (m.budget?.required) L.push(`Budget approval: ${m.budget.satisfied ? `done by @${m.budget.approvedBy.join(', @')}` : `needed from one of ${m.budget.approvers.map((x) => '@' + x).join(', ')} (up to ${money(m.budget.exposure)} > ${money(m.budget.threshold)})`}`);
  if (m.suggestions?.length) L.push(`Lake suggestions: ${m.suggestions.map((x) => `[${x.id}] ${x.title} (saves up to ${money(x.saving[1])})`).join('; ')}`);
  const sg = m.threads.filter((t) => t.suggestion && !t.resolved);
  if (sg.length) L.push(`Reviewer suggestions (accept with lake_submit_revision thread_id): ${sg.map((t) => `[${t.id}] ${t.suggestion.title} by @${t.suggestion.by}`).join('; ')}`);
  if (localDigest && localDigest !== m.digest) L.push(`Note: your local plan file is a different version (${localDigest.slice(0, 8)}) than the PR (${m.short}). Push it so reviewers see it.`);
  const cur = m.verdicts.filter((v) => v.version === m.digest && v.action !== 'revoke');
  if (cur.length) { L.push('', 'Verdicts on this version:'); for (const v of cur) L.push(`- @${v.login} ${v.action === 'approve' ? 'approved' : 'requested changes'}${v.self ? ' (author, does not count)' : ''} via ${v.via}${v.text ? `: ${v.text.replace(/\n+/g, ' ')}` : ''}`); }
  const prev = (m.rounds || []).filter((r) => !r.current);
  if (prev.length) {
    L.push('', 'Earlier rounds:');
    for (const r of prev) {
      const vs = r.verdicts.filter((v) => v.action !== 'revoke');
      L.push(`- round ${r.n} (v${r.short}): ${statusLabel(r.outcome)}${vs.length ? '' : ', no verdicts'}`);
      for (const v of vs) L.push(`    @${v.login} ${v.action === 'approve' ? 'approved' : 'requested changes'}${v.self ? ' (author, does not count)' : ''}${v.text ? `: ${v.text.replace(/\n+/g, ' ').slice(0, 300)}` : ''}`);
    }
  }
  const open = m.threads.filter((t) => !t.resolved);
  if (open.length) {
    L.push('', `Open threads (${open.length}):`);
    for (const t of open) {
      const where = t.anchor ? `${t.anchor.heading ? `"${t.anchor.heading}", ` : ''}line ${t.current ? t.current.start : t.anchor.start}${t.outdated ? ' (outdated: text changed)' : ''}` : 'whole plan';
      L.push(`- [${t.id}] round ${t.n}, ${where}${t.anchor?.quote ? ` on: "${t.anchor.quote.split('\n')[0].slice(0, 120)}"` : ''}`);
      for (const c of t.comments) L.push(`    @${c.login}: ${String(c.text).replace(/\n+/g, ' ')}`);
    }
  }
  const lines = String(m.body).split('\n');
  L.push('', 'Plan text with line numbers (for anchoring comments):', ...lines.slice(0, 400).map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).filter((l) => !/lake:estimate/.test(l)));
  if (link) L.push('', `Review page: ${link}`);
  return L.join('\n');
}

export async function callTool(ctx, name, a = {}) {
  if (ALIASES[name]) [name, a] = ALIASES[name](a);
  if (!fs.existsSync(path.join(ctx.root, '.git'))) return `lake-gate: ${ctx.root} is not a git repository. Open your project folder (the repo with .lake/, set up with \`npx lake-gate init\`) in Claude Code or Cursor, then try again.`;
  const via = `${ctx.clientName} (MCP)`;
  if (name === 'lake_review') {
    const act = a.action;
    if (act === 'approve' || act === 'request_changes') return callTool(ctx, act === 'approve' ? '_approve' : '_changes', { ...a, comment: a.text });
    if (act === 'comment') return callTool(ctx, '_comment', a);
    if (act === 'reply') return callTool(ctx, '_reply', a);
    if (act === 'suggest') return callTool(ctx, '_suggest', { ...a, comment: a.text });
    throw new Error('action must be approve, request_changes, comment, reply or suggest');
  }
  if (name === 'lake_submit_revision' && !a.plan_markdown) {
    if (a.thread_id || a.suggestion_id || a.model) return callTool(ctx, '_apply', a);
    throw new Error('Pass plan_markdown, or one of thread_id / suggestion_id / model.');
  }
  switch (name) {
    case 'lake_request_review': {
      let plan; let note = '';
      if (a.plan_markdown) { const r = exportPlan(ctx.root, a.plan_markdown, { id: a.plan_id, source: 'mcp' }); plan = r.plan; }
      else { plan = loadPlan(ctx.root, resolveId(ctx, a.plan_id)); if (!plan) throw new Error(`No plan ${a.plan_id}`); }
      const cfg = loadConfig(ctx.root);
      if (a.push) note += '\n' + pushPlan(ctx, plan.id, `Plan: ${plan.title} (v${plan.short})`);
      const number = await ctx.pr().catch(() => null);
      if (!number) return `Saved .lake/plans/${plan.id}.md as v${plan.short}.${note}\nNo open PR for this branch yet: commit and push the plan, open a (draft) PR, then call lake_request_review again or lake_review_status.`;
      const g = ctx.github();
      if (a.reviewers?.length) await g.req('POST', `/pulls/${number}/requested_reviewers`, { reviewers: a.reviewers }).catch(() => null);
      const link = reviewLink(cfg, g.repo, number, plan.id);
      await g.req('POST', `/issues/${number}/comments`, { body: [`**Plan ready for review:** ${plan.title} · \`${plan.id}\` v${plan.short}`, a.reviewers?.length ? a.reviewers.map((r) => '@' + r).join(' ') : null,
        a.note ? `\n${a.note}` : null, link ? `\n[Open the plan review](${link})` : null, `\n<sub>via lake-gate · ${via}</sub>`].filter(Boolean).join('\n') });
      return `Review requested on PR #${number} for ${plan.id} v${plan.short}.${note}${link ? `\nReview page: ${link}` : ''}\nCall lake_review_status with wait_seconds to wait for feedback. Do not implement until it is approved.`;
    }
    case 'lake_review_status': {
      const id = await resolvePrPlanId(ctx, a.plan_id);
      const local = loadPlan(ctx.root, id);
      const localCost = () => {
        if (!local) return '';
        const cfg = loadConfig(ctx.root); const est = estimatePlan(local.body, cfg); const rule = budgetRule(est, cfg);
        const st = localStatus(ctx.root, local, cfg);
        return `\nLocal status: ${st.state}${st.trial ? ' (trial)' : ''}.\n\n${formatCost(est, cfg, undefined, rule.required ? { ...rule, satisfied: false } : null)}`;
      };
      let pm;
      try { pm = await prModel(ctx, id); } catch (e) {
        if (/No GitHub remote/.test(e.message)) return `Plan ${id}${local ? ` v${local.short}` : ''} (local only).${localCost()}\n\nAdd a GitHub remote (origin) and open a PR to share it for review.`;
        throw e;
      }
      let { number, model, config, events, pr } = pm;
      if (!number) return `No open PR for this branch yet. Push the plan and open a PR so teammates can review it.${local ? ` Local plan ${id} is v${local.short}.` : ''}${localCost()}`;
      if (!model) return `PR #${number} does not contain .lake/plans/${id}.md yet. Push the plan file.`;
      const wait = Math.min(240, Math.max(0, Number(a.wait_seconds) || 0));
      const sig = (m) => `${m.status}|${m.digest}|${m.verdicts.length}|${m.threads.reduce((n, t) => n + t.comments.length, 0)}`;
      const start = sig(model); let waited = 0;
      while (waited < wait && sig(model) === start) {
        await ctx.sleep(20000); waited += 20;
        ({ model, config, events, pr } = await prModel(ctx, id));
      }
      // Sync locally so the Claude Code hook sees the decision.
      try {
        const digestAt = {}; const raw = await collectEvents(ctx.github(), number);
        for (const p of listPlans(ctx.root)) digestAt[p.id] = await nativeDigests(ctx.github(), raw, `.lake/plans/${p.id}.md`, { headSha: pr.head.sha, config });
        applyEvents(ctx.root, { events: raw, prAuthor: pr.user.login, prNumber: number, digestAt });
      } catch { /* status is still useful without a local sync */ }
      const changed = waited && sig(model) !== start ? `Changed after ${waited}s.\n` : waited ? `No change after ${waited}s.\n` : '';
      const cw = [configWarning(config), configWarning(loadConfig(ctx.root))].filter(Boolean);
      return changed + [...new Set(cw)].map((w) => `Warning: ${w}\n`).join('') + formatReview(model, { localDigest: local?.digest, link: reviewLink(config, ctx.github().repo, number, id) });
    }
    case 'lake_submit_revision': {
      const id = resolveId(ctx, a.plan_id);
      const { plan } = exportPlan(ctx.root, a.plan_markdown, { id, source: 'mcp' });
      let note = '';
      if (a.push) note = '\n' + pushPlan(ctx, plan.id, `Plan revision: ${plan.title} (v${plan.short})`);
      const number = await ctx.pr().catch(() => null);
      if (number) {
        const g = ctx.github();
        await g.req('POST', `/issues/${number}/comments`, { body: [`**Revised plan \`${plan.id}\` → v${plan.short}.** Earlier approvals no longer apply.`, a.note ? `\n${a.note}` : null,
          a.addressed_threads?.length ? `\nAddressed ${a.addressed_threads.length} thread(s).` : null, `\n<sub>via lake-gate · ${via}</sub>`,
          ...(a.addressed_threads || []).map((t) => `<!-- lake:resolve ${JSON.stringify({ p: plan.id, t, r: true })} -->`)].filter(Boolean).join('\n') });
      }
      return `Saved ${plan.id} v${plan.short}.${note}${number ? ` Posted the revision on PR #${number}.` : ' No PR found to notify.'}${a.push ? '' : ' Push the plan file so reviewers see this version.'} Call lake_review_status with wait_seconds to wait.`;
    }
    case '_reply': {
      const number = await ctx.pr(); if (!number) throw new Error('No open PR for this branch.');
      await actions.reply(ctx.github(), number, { planId: await resolvePrPlanId(ctx, a.plan_id), thread: a.thread_id, text: a.text, via });
      return `Replied in thread ${a.thread_id} on PR #${number}.`;
    }
    case '_comment': {
      const id = await resolvePrPlanId(ctx, a.plan_id);
      const { number, model } = await prModel(ctx, id);
      if (!model) throw new Error(`No PR with plan ${id}.`);
      const lines = String(model.body).split('\n'); const s = Math.floor(Number(a.line)); const e = Math.max(s, Math.floor(Number(a.end_line) || s));
      const last = stripEstimate(String(model.body)).replace(/\s+$/, '').split('\n').length;
      if (!Number.isFinite(s) || s < 1) return `Not posted: line ${a.line} is outside the plan (lines 1–${last}). Lines start at 1. Call lake_review_status for the numbered plan text.`;
      if (e > last) return `Not posted: line ${Number.isFinite(e) ? e : a.line} is outside the plan (lines 1–${last}). Call lake_review_status for the numbered plan text.`;
      await actions.comment(ctx.github(), number, { planId: id, version: model.digest, anchor: { start: s, end: e, quote: lines.slice(s - 1, e).join('\n') }, text: a.text, via });
      return `Commented on ${id} v${model.short}, line ${s}${e > s ? `–${e}` : ''}.`;
    }
    case '_approve': case '_changes': {
      const id = await resolvePrPlanId(ctx, a.plan_id);
      const { number, model, pr } = await prModel(ctx, id);
      if (!model) throw new Error(`No open PR with plan ${id}.`);
      const me = (await viewer(ctx.github()))?.login;
      if (me && pr?.user?.login && me.toLowerCase() === pr.user.login.toLowerCase()) return `Not posted: you (@${me}) opened PR #${number}, and authors can't ${name === '_approve' ? 'approve' : 'review'} their own plan. A teammate has to do it.`;
      const v = String(a.version || '').toLowerCase();
      if (v.length < 7 || !model.digest.startsWith(v)) return `Not posted: version ${a.version || '(none)'} is not the current version of ${id}. The current version is ${model.short}. Show the user what changed and ask again.`;
      if (name === '_changes' && !String(a.comment || '').trim()) return 'Not posted: say what needs to change.';
      await actions.verdict(ctx.github(), number, { action: name === '_approve' ? 'approve' : 'reject', planId: id, version: model.digest, text: a.comment, via });
      return `${name === '_approve' ? 'Approved' : 'Requested changes on'} ${id} v${model.short} on PR #${number}. The PR check updates in a few seconds. If you are the PR author it will not count.`;
    }
    case 'lake_cost': {
      const id = resolveId(ctx, a.plan_id);
      const plan = loadPlan(ctx.root, id); if (!plan) throw new Error(`No plan ${id}`);
      const cfg = loadConfig(ctx.root); const est = estimatePlan(plan.body, cfg);
      return `Plan ${id} v${plan.short}\n` + formatCost(est, cfg, undefined, est.exposure > (cfg.budget?.approverAbove ?? Infinity) ? { required: true, exposure: est.exposure, threshold: cfg.budget.approverAbove, approvers: (cfg.budget.approvers || []).map((x) => String(x).replace(/^@/, '')), satisfied: false } : null);
    }
    case '_suggest': {
      const { number, model, config } = await prModel(ctx, await resolvePrPlanId(ctx, a.plan_id));
      if (!model) throw new Error(`No open PR with plan ${a.plan_id}.`);
      const s = patchFor(a, model.estimate, config);
      await actions.suggest(ctx.github(), number, { planId: model.id, version: model.digest, title: s.title, patch: s.patch, saving: s.saving, text: a.comment, via });
      return `Suggested on PR #${number}: ${s.title}. The author can accept it in one click in Lake or with lake_submit_revision.`;
    }
    case '_apply': {
      const id = resolveId(ctx, a.plan_id);
      const plan = loadPlan(ctx.root, id); if (!plan) throw new Error(`No plan ${id}`);
      const cfg = loadConfig(ctx.root);
      let s; let number = null;
      if (a.thread_id) {
        const r = await prModel(ctx, id); number = r.number;
        const t = r.model?.threads.find((x) => x.id === a.thread_id);
        if (!t?.suggestion) throw new Error(`Thread ${a.thread_id} is not a suggestion.`);
        if (t.suggestion.accepted) return `Already applied${t.suggestion.newVersion ? ` (v${String(t.suggestion.newVersion).slice(0, 8)})` : ''}. Nothing to do.`;
        s = { title: t.suggestion.title, patch: t.suggestion.patch };
      } else s = patchFor(a, estimatePlan(plan.body, cfg), cfg);
      const next = applyPatch(stripEstimate(plan.body).replace(/\s+$/, '') + '\n', s.patch);
      if (next.trim() === stripEstimate(plan.body).trim()) return `Already applied: ${id} v${plan.short} already has "${s.title || describePatch(s.patch, cfg)}". Nothing to do.`;
      const { plan: np, estimate } = exportPlan(ctx.root, next, { id, source: 'mcp' });
      const push = a.push ?? true; // one click: apply, commit only the plan file, push
      let note = '';
      if (push) note = '\n' + pushPlan(ctx, id, `Plan ${id}: ${s.title || describePatch(s.patch, cfg)} (v${np.short})`);
      if (a.thread_id && number) await ctx.github().req('POST', `/issues/${number}/comments`, { body: acceptBody({ planId: id, thread: a.thread_id, title: s.title, newVersion: np.digest, via }) });
      return `Applied "${s.title}" to ${id}: new version v${np.short}, ${range(estimate.declared ? estimate.plannedUsd : estimate.usd)}.${note}${push ? '' : ' Push the plan file so reviewers see it.'} Earlier approvals no longer apply.`;
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

// Minimal MCP stdio transport: newline-delimited JSON-RPC 2.0.
export function serve({ input = process.stdin, output = process.stdout, ctxOptions = {} } = {}) {
  let ctx = null;
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  const handle = async (msg) => {
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    try {
      if (method === 'initialize') {
        ctx = createContext({ ...ctxOptions, clientName: params?.clientInfo?.name || 'MCP client' });
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lake-gate', version: VERSION },
          instructions: 'Plan review for coding agents. Request review after planning, wait for approval with lake_review_status, revise with lake_submit_revision. Only approve when the human explicitly says so.' } });
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        ctx = ctx || createContext(ctxOptions);
        try {
          const text = await callTool(ctx, params.name, params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `lake-gate: ${e.message}` }], isError: true } }); }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
  };
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(msg);
    }
  });
  return new Promise((resolve) => input.on('end', resolve));
}

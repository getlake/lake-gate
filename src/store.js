import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { readPlanText, renderPlanFile, slugify, titleOf, splitFrontmatter } from './plan.js';
import { estimatePlan, renderEstimate, autoApproveVerdict } from './estimate.js';

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function repoRoot(cwd = process.cwd()) {
  return git(cwd, ['rev-parse', '--show-toplevel']) || path.resolve(cwd);
}

// Local state lives inside .git so it is never committed and never part of a PR.
export function stateDir(root) {
  const gd = git(root, ['rev-parse', '--absolute-git-dir']);
  const dir = gd ? path.join(gd, 'lake') : path.join(root, '.lake', '.local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

export const plansDir = (root) => path.join(root, '.lake', 'plans');
export const planPath = (root, id) => path.join(plansDir(root), `${id}.md`);

export function getState(root) { return readJson(path.join(stateDir(root), 'state.json'), { active: null, sessions: {} }); }
export function setState(root, s) { writeJson(path.join(stateDir(root), 'state.json'), s); }
export function getApprovals(root) { return readJson(path.join(stateDir(root), 'approvals.json'), {}); }
export function setApprovals(root, a) { writeJson(path.join(stateDir(root), 'approvals.json'), a); }

export function listPlans(root) {
  const d = plansDir(root);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => loadPlan(root, f.slice(0, -3)));
}

export function loadPlan(root, id) {
  const p = planPath(root, id);
  if (!fs.existsSync(p)) return null;
  return { ...readPlanText(fs.readFileSync(p, 'utf8'), id), path: p };
}

function uniqueId(root, base) {
  let id = base; let n = 2;
  while (fs.existsSync(planPath(root, id))) id = `${base}-${n++}`;
  return id;
}

// Writes (or re-versions) a plan file with a fresh estimate. Returns the loaded plan + estimate.
export function exportPlan(root, markdown, { id, source, sessionId, author, fresh = false } = {}) {
  const config = loadConfig(root);
  const state = getState(root);
  const incoming = splitFrontmatter(markdown).body;
  if (!String(incoming).trim()) throw new Error('No plan text found; nothing saved.');
  let planId = id || (sessionId && state.sessions[sessionId]) || null;
  // Re-saving a plan with the same title (the CLI / MCP edit loop) is a new version of it, not a "-2" copy.
  if (!planId && !fresh && !sessionId && fs.existsSync(planPath(root, slugify(titleOf(incoming))))) planId = slugify(titleOf(incoming));
  const before = planId && fs.existsSync(planPath(root, planId)) ? loadPlan(root, planId) : null;
  let created = new Date().toISOString();
  if (planId && fs.existsSync(planPath(root, planId))) {
    const prev = splitFrontmatter(fs.readFileSync(planPath(root, planId), 'utf8')).meta;
    created = prev.created || created;
    author = author || prev.author;
  } else {
    planId = uniqueId(root, planId || slugify(titleOf(incoming)));
  }
  author = author || git(root, ['config', 'user.email']) || undefined;
  const est = estimatePlan(incoming, config);
  if (!est.steps.length) throw new Error('No steps found in the plan; nothing saved. Write the steps as a numbered list (1. 2. 3.).');
  fs.mkdirSync(plansDir(root), { recursive: true });
  fs.writeFileSync(planPath(root, planId), renderPlanFile({ id: planId, title: titleOf(incoming), author, source, created, body: incoming, estimateMd: renderEstimate(est, config) }));
  state.active = planId;
  if (sessionId) state.sessions[sessionId] = planId;
  // Once any version of a plan needs a human, later (smaller) versions don't auto-approve.
  if (!autoApproveVerdict(est, config).eligible) markGated(state, planId);
  setState(root, state);
  const plan = loadPlan(root, planId);
  return { plan, estimate: est, config, previous: before && before.digest !== plan.digest ? before : null, unchanged: !!before && before.digest === plan.digest };
}

export function markGated(state, planId) { state.gated = { ...(state.gated || {}), [planId]: true }; return state; }

// Local approval status of a plan, based on the last `lake-gate sync` from GitHub and the local auto-approve policy.
// Only a human approval synced from the PR (or a trial self-approval) for this exact version counts; auto-approve
// is re-checked locally every time (ctx.codeLines: the local diff, see hook.js).
export function localStatus(root, plan, config = loadConfig(root), ctx = {}) {
  const est = estimatePlan(plan.body, config);
  const rec = getApprovals(root)[plan.id];
  if (rec && rec.digest === plan.digest && rec.state === 'approved') return { state: rec.state, approvers: rec.approvers || [], estimate: est, synced: rec, trial: !!rec.trial };
  if (rec && rec.digest === plan.digest && rec.state === 'changes-requested') return { state: 'changes-requested', approvers: [], blockers: rec.blockers, estimate: est, synced: rec };
  const a = config.autoApprove || {};
  if (a.mode === 'on') {
    const v = autoApproveVerdict(est, config, { gatedBefore: !!getState(root).gated?.[plan.id], codeLines: ctx.codeLines });
    if (v.eligible) return { state: 'auto-approved', approvers: [], estimate: est };
    return { state: 'pending', stale: !!(rec && rec.digest !== plan.digest && rec.state === 'approved'), approvers: [], estimate: est, autoReasons: v.reasons };
  }
  const stale = rec && rec.digest !== plan.digest && rec.state === 'approved';
  return { state: 'pending', stale, approvers: [], estimate: est };
}

// Changed lines of code outside .lake/ in this checkout, compared with where the branch left the default branch
// (or HEAD when there is no remote): committed + uncommitted + untracked. Used to keep auto-approve small.
const branchBase = (root) => ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'].map((r) => git(root, ['merge-base', 'HEAD', r])).find(Boolean) || (git(root, ['rev-parse', '--verify', 'HEAD']) ? 'HEAD' : null);

// Plans this branch adds or changes (committed since it left the default branch, uncommitted, or untracked).
// The hook re-reads this on every call (2 git commands), so the gate follows `git checkout`.
export function branchPlanIds(root) {
  const base = branchBase(root);
  const files = [base ? git(root, ['diff', '--name-only', base, '--', '.lake/plans']) : '', git(root, ['ls-files', '--others', '--exclude-standard', '--', '.lake/plans'])].join('\n');
  return [...new Set(String(files).split('\n').filter((f) => /^\.lake\/plans\/[^/]+\.md$/.test(f) && !f.endsWith('/README.md')).map((f) => f.slice(11, -3)))].filter((id) => loadPlan(root, id));
}

export function localCodeLines(root) {
  const base = branchBase(root);
  let n = 0;
  const num = base ? git(root, ['diff', '--numstat', base, '--', '.', ':(exclude).lake']) : '';
  for (const l of String(num || '').split('\n')) { const [a, d] = l.split('\t'); n += (Number(a) || 0) + (Number(d) || 0); }
  const untracked = String(git(root, ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).lake']) || '').split('\n').filter(Boolean).slice(0, 500);
  for (const f of untracked) { try { const st = fs.statSync(path.join(root, f)); if (st.isFile() && st.size < 2e6) n += fs.readFileSync(path.join(root, f), 'utf8').split('\n').length; } catch { /* gone */ } }
  return n;
}

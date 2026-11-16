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
export function exportPlan(root, markdown, { id, source, sessionId, author } = {}) {
  const config = loadConfig(root);
  const state = getState(root);
  const incoming = splitFrontmatter(markdown).body;
  let planId = id || (sessionId && state.sessions[sessionId]) || null;
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
  fs.mkdirSync(plansDir(root), { recursive: true });
  fs.writeFileSync(planPath(root, planId), renderPlanFile({ id: planId, title: titleOf(incoming), author, source, created, body: incoming, estimateMd: renderEstimate(est, config) }));
  state.active = planId;
  if (sessionId) state.sessions[sessionId] = planId;
  setState(root, state);
  return { plan: loadPlan(root, planId), estimate: est, config };
}

// Local approval status of a plan, based on the last `lake-gate sync` from GitHub and the local auto-approve policy.
export function localStatus(root, plan, config = loadConfig(root)) {
  const est = estimatePlan(plan.body, config);
  const rec = getApprovals(root)[plan.id];
  if (rec && rec.digest === plan.digest && (rec.state === 'approved' || rec.state === 'auto-approved')) return { state: rec.state, approvers: rec.approvers || [], estimate: est, synced: rec, trial: !!rec.trial };
  if (rec && rec.digest === plan.digest && rec.state === 'changes-requested') return { state: 'changes-requested', approvers: [], blockers: rec.blockers, estimate: est, synced: rec };
  const a = config.autoApprove || {};
  if (a.mode === 'on') {
    const v = autoApproveVerdict(est, config);
    if (v.eligible) return { state: 'auto-approved', approvers: [], estimate: est };
  }
  const stale = rec && rec.digest !== plan.digest && (rec.state === 'approved' || rec.state === 'auto-approved');
  return { state: 'pending', stale, approvers: [], estimate: est };
}

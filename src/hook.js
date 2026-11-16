import path from 'node:path';
import { loadConfig } from './config.js';
import { repoRoot, stateDir, getState, setState, loadPlan, exportPlan, localStatus } from './store.js';
import { range } from './estimate.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function out(decision, reason, extra = {}) {
  if (!decision) return extra.systemMessage ? { systemMessage: extra.systemMessage } : null;
  return { ...(extra.systemMessage ? { systemMessage: extra.systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

function approveHint(plan, config) {
  if (config?.try) return `Trial mode: the user can run \`npx lake-gate approve\` to approve it locally (does not count on the PR).`;
  return `Commit .lake/plans/${plan.id}.md, push and open a PR. A teammate (not you) comments:\n  /lake approve ${plan.id}@${plan.short}\nThen run: npx lake-gate sync`;
}

// Pure decision for one Claude Code PreToolUse payload. Returns the JSON object to print (or null for "no opinion").
export function handleClaudePreToolUse(input, env = process.env) {
  if (env.LAKE_GATE === 'off') return null;
  const root = repoRoot(input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  const config = loadConfig(root);
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (tool === 'ExitPlanMode') {
    if (!ti.plan || !String(ti.plan).trim()) return null;
    const { plan, estimate } = exportPlan(root, ti.plan, { source: 'claude-code', sessionId: input.session_id });
    const st = localStatus(root, plan, config);
    const gateNote = st.state === 'approved' || st.state === 'auto-approved' ? `Already ${st.state}` : 'Implementation is gated until a teammate approves this version';
    return out(null, null, { systemMessage: `Lake: plan saved to .lake/plans/${plan.id}.md (version ${plan.short}, ${estimate.complexity} complexity, est. ${range(estimate.usd)}). ${gateNote}.` });
  }

  if (config.localGate === 'off' || !config.gatedTools.includes(tool)) return null;
  if (input.permission_mode === 'plan') return null; // plan mode is read-only already

  const sdir = stateDir(root);
  if (FILE_TOOLS.has(tool)) {
    const fp = path.resolve(root, ti.file_path || ti.notebook_path || '');
    if (inside(fp, sdir)) return out('deny', 'Lake: local approval state cannot be edited by the agent.');
    if (inside(fp, path.join(root, '.lake', 'plans'))) return null; // editing a plan is allowed; it creates a new version
    if (!inside(fp, root)) return null; // outside the repo is out of scope
  }
  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    if (/\.git\/lake|lake[\\/]+(state|approvals)\.json/.test(cmd)) return out('deny', 'Lake: local approval state cannot be edited by the agent.');
    if (/lake-gate(@\S+)?\s+use\b/.test(cmd)) return out('deny', 'Lake: switching the active plan is a human action. Ask the user to run `npx lake-gate use <id>`.');
    if (/lake-gate(@\S+)?\s+approve\b/.test(cmd)) return out('deny', 'Lake: approving is a human action. Ask the user to run `npx lake-gate approve` themselves.');
    const ro = config.readOnlyBash.some((r) => new RegExp(r).test(cmd)) && !/[;&|`$()<>]/.test(cmd.replace(/2>&1|\|\s*(head|tail|wc|rg|grep|sort|uniq)\b[^|;&]*/g, ''));
    if (ro) return null;
  }

  const decision = config.localGate === 'ask' ? 'ask' : 'deny';
  const state = getState(root);
  const activeId = (input.session_id && state.sessions[input.session_id]) || state.active;
  const plan = activeId && loadPlan(root, activeId);
  if (!plan) {
    // Only planned work is gated, so installing lake-gate never blocks a typo fix. Teams that want every
    // change planned set "gateWithoutPlan": true.
    if (config.gateWithoutPlan) return out(decision, 'Lake: no plan for this work yet. Write a short plan first (Claude Code plan mode, then exit plan mode) or export one with `npx lake-gate plan <file.md>`. Implementation is gated until the plan is approved by a teammate.');
    const sid = input.session_id || 'default';
    if ((state.noticed || []).includes(sid)) return null;
    state.noticed = [...(state.noticed || []).slice(-50), sid]; setState(root, state);
    return out(null, null, { systemMessage: 'lake-gate: no plan for this task, so it is not gated. Use plan mode to gate bigger work.' });
  }
  const st = localStatus(root, plan, config);
  if (st.state === 'approved' || st.state === 'auto-approved') return null;
  const why = st.state === 'changes-requested' ? `changes were requested by ${(st.blockers || []).map((b) => '@' + b).join(', ')}` :
    st.stale ? 'the plan was edited after it was approved, so the approval no longer applies' : 'it is not approved yet';
  return out(decision, `Lake: plan "${plan.id}" version ${plan.short} blocks implementation because ${why}. Do not work around this gate; stop and tell the user.\n${approveHint(plan, config)}`);
}

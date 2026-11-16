import path from 'node:path';
import { loadConfig, configWarning } from './config.js';
import { repoRoot, stateDir, getState, setState, loadPlan, exportPlan, localStatus, markGated, localCodeLines, branchPlanIds } from './store.js';
import { range, costLabel } from './estimate.js';

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
  const config = loadConfig(root); // never throws: a broken file means defaults + a warning
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  // A broken policy file is shown on every gated call until it's fixed (the rule in force is the last valid one,
  // or the strict fallback): the user sees it in Claude Code, and the agent can tell them.
  const warn = config.configError ? `lake-gate: ${configWarning(config)}` : null;
  const r = decide();
  if (!warn) return r;
  if (!r) return { systemMessage: warn };
  return { ...r, systemMessage: [r.systemMessage, warn].filter(Boolean).join('\n') };

  function decide() { // eslint-disable-line no-inner-declarations

  if (tool === 'ExitPlanMode') {
    if (!ti.plan || !String(ti.plan).trim()) return null;
    let saved;
    try { saved = exportPlan(root, ti.plan, { source: 'claude-code', sessionId: input.session_id }); } catch (e) { return out(null, null, { systemMessage: `Lake: plan not saved: ${e.message}` }); }
    const { plan, estimate } = saved;
    const st = localStatus(root, plan, config);
    const gateNote = st.state === 'approved' || st.state === 'auto-approved' ? `Already ${st.state}` : 'Implementation is gated until a teammate approves this version';
    return out(null, null, { systemMessage: `Lake: plan saved to .lake/plans/${plan.id}.md (version ${plan.short}, ${estimate.complexity} complexity, est. ${costLabel(estimate)}). ${gateNote}.` });
  }

  if (config.localGate === 'off' || !config.gatedTools.includes(tool)) return null;
  if (input.permission_mode === 'plan') return null; // plan mode is read-only already

  const sdir = stateDir(root);
  if (FILE_TOOLS.has(tool)) {
    const fp = path.resolve(root, ti.file_path || ti.notebook_path || '');
    if (inside(fp, sdir)) return out('deny', 'Lake: local approval state cannot be edited by the agent.');
    // Plans and policy change through tracked paths only (plan mode, `npx lake-gate plan`, lake_submit_revision),
    // so an agent can't rewrite a blocked plan or loosen the policy to open the gate.
    if (inside(fp, path.join(root, '.lake'))) return out('deny', 'Lake: files in .lake/ are not edited directly. To change the plan, use plan mode again, `npx lake-gate plan <file.md>`, or the lake_submit_revision tool; every change is a new version that needs approval. Policy (.lake/config.json) is changed by a human.');
    if (!inside(fp, root)) return null; // outside the repo is out of scope
  }
  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    if (/\.git\/lake|lake[\\/]+(state|approvals)\.json/.test(cmd)) return out('deny', 'Lake: local approval state cannot be edited by the agent.');
    if (/lake-gate(@\S+)?\s+use\b/.test(cmd)) return out('deny', 'Lake: switching the active plan is a human action. Ask the user to run `npx lake-gate use <id>`.');
    if (/lake-gate(@\S+)?\s+approve\b/.test(cmd)) return out('deny', 'Lake: approving is a human action. Ask the user to run `npx lake-gate approve` themselves.');
    if (/\.lake[\\/]+(plans|config\.json)/.test(cmd) && !isReadOnly(cmd, config)) return out('deny', 'Lake: plan files and .lake/config.json are not changed from the shell. Use plan mode, `npx lake-gate plan <file.md>` or lake_submit_revision for a new plan version.');
    if (isReadOnly(cmd, config)) return null;
  }

  const decision = config.localGate === 'ask' ? 'ask' : 'deny';
  const state = getState(root);
  // Which plan gates this work, re-resolved on every call so it follows `git checkout`: this session's plan,
  // else the plans this branch changes (all of them must pass), else the last active plan if it's in this checkout.
  const sessionPlan = input.session_id && state.sessions[input.session_id] && loadPlan(root, state.sessions[input.session_id]);
  const onBranch = sessionPlan ? [] : branchPlanIds(root);
  const candidates = sessionPlan ? [sessionPlan]
    : onBranch.length ? [...onBranch].sort((a, b) => (b === state.active) - (a === state.active)).map((id) => loadPlan(root, id))
    : [state.active && loadPlan(root, state.active)].filter(Boolean);
  const codeLines = candidates.length ? localCodeLines(root) + (FILE_TOOLS.has(tool) ? String(ti.content || ti.new_string || (ti.edits || []).map((e) => e.new_string).join('\n') || '').split('\n').length : 0) : 0;
  const statuses = candidates.map((p) => [p, localStatus(root, p, config, { codeLines })]);
  const [plan, st] = statuses.find(([, x]) => x.state !== 'approved' && x.state !== 'auto-approved') || statuses[0] || [];
  if (!plan) {
    // Only planned work is gated, so installing lake-gate never blocks a typo fix. Teams that want every
    // change planned set "gateWithoutPlan": true.
    if (config.gateWithoutPlan) return out(decision, 'Lake: no plan for this work yet. Write a short plan first (Claude Code plan mode, then exit plan mode) or export one with `npx lake-gate plan <file.md>`. Implementation is gated until the plan is approved by a teammate.');
    const sid = input.session_id || 'default';
    if ((state.noticed || []).includes(sid)) return null;
    state.noticed = [...(state.noticed || []).slice(-50), sid]; setState(root, state);
    return out(null, null, { systemMessage: 'lake-gate: no plan for this task, so it is not gated. Use plan mode to gate bigger work.' });
  }
  if (st.state === 'approved' || st.state === 'auto-approved') return null;
  if (!st.stale && st.state === 'pending') { const s2 = getState(root); if (!s2.gated?.[plan.id]) setState(root, markGated(s2, plan.id)); }
  if (st.autoReasons?.some((x) => /changed lines/.test(x)) && !(st.autoReasons || []).some((x) => !/changed lines/.test(x))) {
    return out(decision, `Lake: plan "${plan.id}" was small enough to auto-approve, but the work has grown past it (${st.autoReasons.join('; ')}). Stop and tell the user: a teammate should review the plan now.\n${approveHint(plan, config)}`);
  }
  const why = st.state === 'changes-requested' ? `changes were requested by ${(st.blockers || []).map((b) => '@' + b).join(', ')}` :
    st.stale ? 'the plan was edited after it was approved, so the approval no longer applies' : 'it is not approved yet';
  return out(decision, `Lake: plan "${plan.id}" version ${plan.short} blocks implementation because ${why}. Do not work around this gate; stop and tell the user.\n${approveHint(plan, config)}`);
}
}

// Read-only shell commands pass the gate. One simple command only: no chaining, redirection, substitution or
// newlines, and nothing that can delete through a read-only command's flags (find -delete, env <cmd>, git branch -D).
export function isReadOnly(cmd, config) {
  const c = String(cmd);
  if (/[\n\r]/.test(c.trim())) return false;
  if (/^\s*find\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(c)) return false;
  if (/^\s*env\s+\S/.test(c) && !/^\s*env\s*(\||$)/.test(c)) return false;
  if (/^\s*git\s+branch\b.*\s(-[a-zA-Z]*[dDmMcC]|--delete|--move|--copy|--force|-f)\b/.test(c)) return false;
  if (/^\s*git\s+remote\s+(add|remove|rm|rename|set-url|set-head|prune)\b/.test(c)) return false;
  return config.readOnlyBash.some((r) => new RegExp(r).test(c)) && !/[;&|`$()<>]/.test(c.replace(/2>&1|\|\s*(head|tail|wc|rg|grep|sort|uniq)\b[^|;&]*/g, ''));
}

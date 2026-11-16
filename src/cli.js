import fs from 'node:fs';
import { repoRoot, exportPlan, loadPlan, listPlans, getState, setState, localStatus, getApprovals, setApprovals } from './store.js';
import { loadConfig, configWarning } from './config.js';
import { estimatePlan, renderEstimate, range, costLabel } from './estimate.js';
import { handleClaudePreToolUse } from './hook.js';
import { syncFromGitHub, applyEvents } from './sync.js';
import { init, uninstall, ACTION_REF } from './init.js';
import { startUi } from './ui-server.js';
import { serve as serveMcp } from './mcp.js';

const HELP = `lake-gate: version-bound team approval for AI coding agent plans

Usage:
  lake-gate init [--try] [--force]                        Set up .lake/, the Claude Code hook, MCP and the GitHub workflow
                                                           --try: solo trial, approve your own plans locally
  lake-gate approve [id]                                   Trial mode only: approve the active plan locally (never counts on the PR)
  lake-gate uninstall                                      Remove the hook, MCP entries and workflow (keeps .lake/ plans)
  lake-gate plan <file.md|->  [--id name]                 Save a plan (any agent) to .lake/plans/ with an estimate; make it active
  lake-gate estimate <file.md|->                          Print complexity, model per step and cost range
  lake-gate status                                         Active plan, version and approval state
  lake-gate sync [--pr N]                                  Pull approvals from the PR on GitHub (uses GITHUB_TOKEN or gh)
  lake-gate check [--plan id]                              Exit 0 if the active plan's current version is approved (pre-run check)
  lake-gate use <id>                                       Set the active plan (human only; the hook blocks agents)
  lake-gate hook claude                                    Claude Code PreToolUse hook (reads JSON on stdin)
  lake-gate ui [--port 4848] [--no-open]                   Review UI on localhost: plans, inline comments, rounds, one-click approve
  lake-gate mcp                                            MCP server (stdio) for Claude Code / Cursor: request review, wait, revise, approve

No telemetry. No backend. Docs: https://github.com/getlake/lake-gate`;

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const readInput = (f) => {
  if (f === '-' || !f) return fs.readFileSync(0, 'utf8');
  if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

function describe(root, plan) {
  const st = localStatus(root, plan);
  const extra = st.state === 'pending' ? (st.stale ? ' (approval is for an older version)' : '') + (loadConfig(root).try ? '\n  approve locally: npx lake-gate approve' : `\n  approve on the PR: /lake approve ${plan.id}@${plan.short}`) : st.approvers?.length ? ` by ${st.approvers.map((a) => '@' + a).join(', ')}` : '';
  const e = st.estimate;
  return `${plan.id}  v${plan.short}  ${e.complexity}  est. ${costLabel(e)}  ${st.state === 'pending' ? 'in review' : st.state}${st.trial ? ' (trial, local only)' : ''}${extra}`;
}

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const [cmd, ...args] = argv;
  const root = repoRoot();
  switch (cmd) {
    case 'init': {
      const trial = args.includes('--try');
      for (const l of init(root, { actionRef: flag(args, '--action-ref') || ACTION_REF, force: args.includes('--force'), trial })) io.out(l);
      if (trial) io.out('\nTrial mode. Try the loop in 2 minutes:\n  1. In Claude Code, plan a task in plan mode and accept the plan. Edits are now gated.\n  2. npx lake-gate approve      (you approve your own plan, locally only)\n  3. The agent continues. Edit the plan and it is gated again.\nFor your team: remove "try" from .lake/config.json, then:');
      io.out(`${trial ? '' : '\nNext:\n'}  git add .lake .claude .github .mcp.json .cursor && git commit -m "Add lake-gate" && git push\n  Then review plans with: npx lake-gate ui   (or in GitHub with Review changes → Approve)\n  Optional: require the "lake/plan-approval" status check in branch protection.`);
      return 0;
    }
    case 'uninstall': {
      for (const l of uninstall(root)) io.out(l);
      io.out('Kept .lake/ (your plans and config). Delete it yourself if you want it gone, then commit. Remove "lake/plan-approval" from required checks if you set it.');
      return 0;
    }
    case 'plan': {
      const { plan, estimate, config, previous, unchanged } = exportPlan(root, readInput(args.find((a) => !a.startsWith('--') && a !== flag(args, '--id'))), { id: flag(args, '--id'), source: 'cli', fresh: args.includes('--new') });
      io.out(previous ? `Updated ${plan.id} → v${plan.short} (was v${previous.short}; approval reset)  ${estimate.complexity}  est. ${costLabel(estimate)}`
        : `${unchanged ? 'Unchanged' : 'Saved'} .lake/plans/${plan.id}.md  version ${plan.short}  ${estimate.complexity}  est. ${costLabel(estimate)}`);
      const st = localStatus(root, plan, config);
      if (st.state === 'approved' || st.state === 'auto-approved') io.out(st.state === 'auto-approved' ? 'Auto-approved (small plan). The agent can build.' : 'Approved. The agent can build.');
      else if (config.try) io.out('Approve locally: npx lake-gate approve');
      else io.out(`Approve on the PR with: /lake approve ${plan.id}@${plan.short}`);
      return 0;
    }
    case 'estimate': {
      const cfg = loadConfig(root);
      io.out(renderEstimate(estimatePlan(readInput(args[0]), cfg), cfg));
      return 0;
    }
    case 'status': {
      const st = getState(root);
      const plans = listPlans(root);
      const cw = configWarning(loadConfig(root));
      if (cw) io.err(`Warning: ${cw}`);
      if (!plans.length) { io.out('No plans yet. Use plan mode in Claude Code, or: lake-gate plan <file.md>'); return 0; }
      for (const p of plans) io.out(`${p.id === st.active ? '*' : ' '} ${describe(root, p)}`);
      return 0;
    }
    case 'sync': {
      if (flag(args, '--from-json')) { // offline/testing: {prAuthor, events}
        const j = JSON.parse(fs.readFileSync(flag(args, '--from-json'), 'utf8'));
        applyEvents(root, j);
      } else {
        const r = await syncFromGitHub(root, { pr: flag(args, '--pr') && Number(flag(args, '--pr')) });
        io.out(`Synced approvals from PR #${r.pr}.`);
      }
      for (const p of listPlans(root)) io.out('  ' + describe(root, p));
      return 0;
    }
    case 'check': {
      const id = flag(args, '--plan') || getState(root).active;
      const plan = id && loadPlan(root, id);
      if (!plan) { io.err('lake-gate: no active plan.'); return 1; }
      const cw = configWarning(loadConfig(root));
      if (cw) io.err(`Warning: ${cw}`);
      const st = localStatus(root, plan);
      const ok = st.state === 'approved' || st.state === 'auto-approved';
      (ok ? io.out : io.err)(describe(root, plan));
      return ok ? 0 : 1;
    }
    case 'approve': {
      const cfg = loadConfig(root);
      if (!cfg.try) { io.err('lake-gate approve works in trial mode only (npx lake-gate init --try). On a team, a teammate approves on the PR or in `npx lake-gate ui`.'); return 1; }
      const id = args[0] || getState(root).active; const plan = id && loadPlan(root, id);
      if (!plan) { io.err('lake-gate: no plan to approve.'); return 1; }
      const store = getApprovals(root);
      store[plan.id] = { digest: plan.digest, state: 'approved', approvers: ['you (trial)'], trial: true, syncedAt: new Date().toISOString() };
      setApprovals(root, store);
      io.out(`Approved ${plan.id} v${plan.short} locally (trial self-approval, does not count on the PR). The agent can build this version.`);
      return 0;
    }
    case 'use': {
      if (!args[0] || !loadPlan(root, args[0])) { io.err(`No plan named ${args[0]}`); return 1; }
      const st = getState(root); st.active = args[0]; setState(root, st);
      io.out(`Active plan: ${args[0]}`);
      return 0;
    }
    case 'hook': {
      if (args[0] !== 'claude') { io.err('Supported: lake-gate hook claude'); return 1; }
      let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* not JSON: no opinion */ }
      let res;
      // Never brick the agent on an unexpected hook error: say what happened and let this call through.
      try { res = handleClaudePreToolUse(input); } catch (e) { res = { systemMessage: `lake-gate hook error (this call was not gated): ${e.message}` }; }
      if (res) io.out(JSON.stringify(res));
      return 0;
    }
    case 'ui': {
      const port = Number(flag(args, '--port') || 4848);
      let r;
      try { r = await startUi({ root, port, open: !args.includes('--no-open') }); } catch (e) {
        if (/EADDRINUSE/.test(e.message)) { io.err(`lake-gate: port ${port} is busy (another \`lake-gate ui\`?). Try: npx lake-gate ui --port ${port + 1}`); return 1; }
        throw e;
      }
      io.out(`Lake review UI: ${r.url}`);
      io.out(r.repo ? `Repo ${r.repo}. ${r.hasToken ? 'Posting as your GitHub login (token stays on this machine).' : 'No GitHub token found: read-only for public repos. Run `gh auth login` to post.'}` : 'No GitHub remote: showing local plans only.');
      io.out('Ctrl+C to stop.');
      return 0;
    }
    case 'mcp': { await serveMcp(); return 0; }
    case undefined: case 'help': case '--help': case '-h': io.out(HELP); return 0;
    case '--version': case '-v': io.out(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); return 0;
    default: io.err(`Unknown command: ${cmd}\n\n${HELP}`); return 1;
  }
}

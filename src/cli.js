import fs from 'node:fs';
import { repoRoot, exportPlan, loadPlan, listPlans, getState, setState, localStatus } from './store.js';
import { loadConfig } from './config.js';
import { estimatePlan, renderEstimate, range } from './estimate.js';
import { handleClaudePreToolUse } from './hook.js';
import { syncFromGitHub, applyEvents } from './sync.js';
import { init, ACTION_REF } from './init.js';

const HELP = `lake-gate: version-bound team approval for AI coding agent plans

Usage:
  lake-gate init [--action-ref owner/repo@ref] [--force]   Set up .lake/, the Claude Code hook and the GitHub workflow
  lake-gate plan <file.md|->  [--id name]                 Save a plan (any agent) to .lake/plans/ with an estimate; make it active
  lake-gate estimate <file.md|->                          Print complexity, model per step and cost range
  lake-gate status                                         Active plan, version and approval state
  lake-gate sync [--pr N]                                  Pull approvals from the PR on GitHub (uses GITHUB_TOKEN or gh)
  lake-gate check [--plan id]                              Exit 0 if the active plan's current version is approved (pre-run check)
  lake-gate use <id>                                       Set the active plan (human only; the hook blocks agents)
  lake-gate hook claude                                    Claude Code PreToolUse hook (reads JSON on stdin)

No telemetry. No backend. Docs: https://github.com/lakeresearch/lake-gate`;

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const readInput = (f) => (f === '-' || !f ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'));

function describe(root, plan) {
  const st = localStatus(root, plan);
  const extra = st.state === 'pending' ? (st.stale ? ' (approval is for an older version)' : '') + `\n  approve on the PR: /lake approve ${plan.id}@${plan.short}` : st.approvers?.length ? ` by ${st.approvers.map((a) => '@' + a).join(', ')}` : '';
  return `${plan.id}  v${plan.short}  ${st.estimate.complexity}  est. ${range(st.estimate.usd)}  ${st.state}${extra}`;
}

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const [cmd, ...args] = argv;
  const root = repoRoot();
  switch (cmd) {
    case 'init': {
      for (const l of init(root, { actionRef: flag(args, '--action-ref') || ACTION_REF, force: args.includes('--force') })) io.out(l);
      io.out('\nNext:\n  1. git add .lake .claude .github && git commit -m "Add lake-gate"\n  2. In GitHub branch protection, require the status check "lake/plan-approval".\n  3. Optional: npm i -D lake-gate (faster hook than npx).');
      return 0;
    }
    case 'plan': {
      const { plan, estimate } = exportPlan(root, readInput(args.find((a) => !a.startsWith('--') && a !== flag(args, '--id'))), { id: flag(args, '--id'), source: 'cli' });
      io.out(`Saved .lake/plans/${plan.id}.md  version ${plan.short}  ${estimate.complexity}  est. ${range(estimate.usd)}`);
      io.out(`Approve on the PR with: /lake approve ${plan.id}@${plan.short}`);
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
      const st = localStatus(root, plan);
      const ok = st.state === 'approved' || st.state === 'auto-approved';
      (ok ? io.out : io.err)(describe(root, plan));
      return ok ? 0 : 1;
    }
    case 'use': {
      if (!args[0] || !loadPlan(root, args[0])) { io.err(`No plan named ${args[0]}`); return 1; }
      const st = getState(root); st.active = args[0]; setState(root, st);
      io.out(`Active plan: ${args[0]}`);
      return 0;
    }
    case 'hook': {
      if (args[0] !== 'claude') { io.err('Supported: lake-gate hook claude'); return 1; }
      const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      const res = handleClaudePreToolUse(input);
      if (res) io.out(JSON.stringify(res));
      return 0;
    }
    case undefined: case 'help': case '--help': case '-h': io.out(HELP); return 0;
    case '--version': case '-v': io.out(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); return 0;
    default: io.err(`Unknown command: ${cmd}\n\n${HELP}`); return 1;
  }
}

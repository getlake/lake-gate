import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { listPlans, getApprovals, setApprovals } from './store.js';
import { estimatePlan } from './estimate.js';
import { evaluatePlan } from './policy.js';
import { client, collectEvents, nativeDigests } from './github.js';
import { expandEvents } from './review.js';

const sh = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

export function parseRemote(url) {
  const m = String(url || '').match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Applies GitHub approvals to the LOCAL plan files. An approval only counts if its digest matches the local file,
// so a plan edited locally after approval is pending again.
export function applyEvents(root, { events, prAuthor, prNumber, digestAt = {} }) {
  const config = loadConfig(root);
  const store = getApprovals(root);
  const results = [];
  for (const plan of listPlans(root)) {
    const planEvents = expandEvents(events.map((e, i) => ({ ...e, id: e.id ?? i })), { planId: plan.id, digestAt: digestAt[plan.id] || {}, config });
    const r = evaluatePlan({ plan, estimate: estimatePlan(plan.body, config), events: planEvents, prAuthor, config });
    store[plan.id] = { digest: plan.digest, state: r.state, approvers: r.approvers, blockers: r.blockers, pr: prNumber ?? null, syncedAt: new Date().toISOString() };
    results.push(r);
  }
  setApprovals(root, store);
  return results;
}

export async function syncFromGitHub(root, { pr, token, fetchImpl } = {}) {
  const repo = parseRemote(sh('git', ['remote', 'get-url', 'origin'], root));
  if (!repo) throw new Error('No GitHub remote named origin.');
  token = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || sh('gh', ['auth', 'token'], root);
  if (!token) throw new Error('Need GitHub read access: set GITHUB_TOKEN or run `gh auth login`.');
  const gh = client({ token, repo, fetchImpl });
  let number = pr;
  if (!number) {
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const prs = await gh.req('GET', `/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${branch}`)}`);
    if (!prs || !prs.length) throw new Error(`No open PR for branch ${branch}. Push and open one, then run sync again.`);
    number = prs[0].number;
  }
  const prObj = await gh.req('GET', `/pulls/${number}`);
  const events = await collectEvents(gh, number);
  const config = loadConfig(root); const digestAt = {};
  for (const plan of listPlans(root)) digestAt[plan.id] = await nativeDigests(gh, events, `.lake/plans/${plan.id}.md`, { headSha: prObj.head.sha, config });
  return { pr: number, results: applyEvents(root, { events, prAuthor: prObj.user.login, prNumber: number, digestAt }) };
}

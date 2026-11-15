#!/usr/bin/env node
// GitHub Action entry point. Uses only the REST API with the workflow's GITHUB_TOKEN; no checkout needed.
import fs from 'node:fs';
import { client, evaluatePr, publish, renderSummary } from './github.js';
import { isPassing } from './policy.js';
import { verdictBody, encodeMarker } from './review.js';

export const CHECK_NAME = 'Lake plan review';

export function prNumberFromEvent(name, payload) {
  if (payload.pull_request) return payload.pull_request.number;
  if (name === 'issue_comment' && payload.issue && payload.issue.pull_request) return payload.issue.number;
  if (name === 'check_run' && payload.check_run?.pull_requests?.length) return payload.check_run.pull_requests[0].number;
  return null;
}

// Experimental (config.checkButtons): one-click buttons on a check run. A click arrives as a
// check_run "requested_action" event; the Action relays it as a bot comment that names the clicker,
// after checking the clicker has write access. Not yet verified against real GitHub.
export function checkActions(ev) {
  const pending = ev.results.filter((r) => !isPassing(r));
  if (pending.length === 1) {
    const r = pending[0];
    return [{ label: 'Approve plan', description: `Approve ${r.id}@${r.short}`.slice(0, 40), identifier: `approve:${r.short}` },
      { label: 'Request changes', description: `Block ${r.id}@${r.short}`.slice(0, 40), identifier: `reject:${r.short}` }];
  }
  return pending.slice(0, 3).map((r) => ({ label: `Approve ${r.id}`.slice(0, 20), description: `Approve ${r.id}@${r.short}`.slice(0, 40), identifier: `approve:${r.short}` }));
}

export async function publishCheck(gh, ev) {
  const actions = checkActions(ev);
  await gh.req('POST', '/check-runs', { name: CHECK_NAME, head_sha: ev.pr.head.sha, status: 'completed', conclusion: actions.length ? 'action_required' : 'success',
    output: { title: ev.description.slice(0, 120), summary: renderSummary(ev).slice(0, 60000) }, ...(actions.length ? { actions } : {}) });
}

const WRITE = new Set(['admin', 'maintain', 'write']);
export async function relayCheckAction(gh, payload, ev) {
  const [action, short] = String(payload.requested_action?.identifier || '').split(':');
  const login = payload.sender?.login;
  if (!['approve', 'reject'].includes(action) || !short || !login || payload.sender.type === 'Bot') return { relayed: false, reason: 'bad request' };
  if (payload.check_run?.head_sha && payload.check_run.head_sha !== ev.pr.head.sha) return { relayed: false, reason: 'stale check run (PR has new commits)' };
  const plan = ev.results.find((r) => r.short === short);
  if (!plan) return { relayed: false, reason: `no plan at version ${short}` };
  const perm = await gh.req('GET', `/collaborators/${encodeURIComponent(login)}/permission`);
  if (!perm || !WRITE.has(perm.permission)) return { relayed: false, reason: `@${login} lacks write access` };
  const body = verdictBody({ action, planId: plan.id, version: plan.digest, text: `${action === 'approve' ? 'Approved' : 'Changes requested'} by @${login} with the check-run button.`, via: 'GitHub check button' })
    + '\n' + encodeMarker('proxy', { by: login, assoc: 'COLLABORATOR' });
  await gh.req('POST', `/issues/${ev.pr.number}/comments`, { body });
  return { relayed: true, login, action, plan: plan.id };
}

export async function runAction(env = process.env, fetchImpl) {
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = prNumberFromEvent(env.GITHUB_EVENT_NAME, payload);
  if (!number) { console.log('lake-gate: not a pull request event, nothing to do.'); return null; }
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  const gh = client({ token, repo: env.GITHUB_REPOSITORY, api: env.GITHUB_API_URL || 'https://api.github.com', fetchImpl });
  let ev = await evaluatePr(gh, number);
  if (env.GITHUB_EVENT_NAME === 'check_run' && payload.action === 'requested_action') {
    const r = await relayCheckAction(gh, payload, ev);
    console.log(`lake-gate: check button: ${r.relayed ? `${r.action} ${r.plan} by @${r.login}` : `ignored (${r.reason})`}`);
    if (r.relayed) ev = await evaluatePr(gh, number);
  }
  await publish(gh, ev, { comment: (env.INPUT_COMMENT || 'true') !== 'false' });
  if (ev.config.checkButtons && ev.results.length) await publishCheck(gh, ev).catch((e) => console.log(`lake-gate: could not create check run buttons: ${e.message}`));
  const md = renderSummary(ev);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `state=${ev.state}\n`);
  console.log(`lake-gate: ${ev.state}: ${ev.description}`);
  return ev;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAction().catch((e) => { console.error(`::error::lake-gate: ${e.message}`); process.exit(1); });
}

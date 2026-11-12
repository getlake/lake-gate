#!/usr/bin/env node
// GitHub Action entry point. Uses only the REST API with the workflow's GITHUB_TOKEN; no checkout needed.
import fs from 'node:fs';
import { client, evaluatePr, publish, renderSummary } from './github.js';

export function prNumberFromEvent(name, payload) {
  if (payload.pull_request) return payload.pull_request.number;
  if (name === 'issue_comment' && payload.issue && payload.issue.pull_request) return payload.issue.number;
  return null;
}

export async function runAction(env = process.env, fetchImpl) {
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = prNumberFromEvent(env.GITHUB_EVENT_NAME, payload);
  if (!number) { console.log('lake-gate: not a pull request event, nothing to do.'); return null; }
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  const gh = client({ token, repo: env.GITHUB_REPOSITORY, api: env.GITHUB_API_URL || 'https://api.github.com', fetchImpl });
  const ev = await evaluatePr(gh, number);
  await publish(gh, ev, { comment: (env.INPUT_COMMENT || 'true') !== 'false' });
  const md = renderSummary(ev);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `state=${ev.state}\n`);
  console.log(`lake-gate: ${ev.state}: ${ev.description}`);
  return ev;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAction().catch((e) => { console.error(`::error::lake-gate: ${e.message}`); process.exit(1); });
}

import { parseConfig } from './config-core.js';
import { readPlanText } from './plan.js';
import { estimatePlan, range } from './estimate.js';
import { evaluatePlan, isPassing, parseCommands } from './policy.js';
import { expandEvents } from './review.js';

export const STATUS_CONTEXT = 'lake/plan-approval';
export const MARKER = '<!-- lake-gate:summary -->';

// Works in Node and in the browser review UI.
export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export function client({ token, repo, api = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  const [owner, name] = repo.split('/');
  async function req(method, url, body) {
    const full = url.startsWith('http') ? url : url.startsWith('~/') ? `${api}${url.slice(1)}` : `${api}/repos/${owner}/${name}${url}`;
    const res = await fetchImpl(full, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(typeof window === 'undefined' ? { 'User-Agent': 'lake-gate' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  async function all(url) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const chunk = await req('GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!chunk || !chunk.length) break;
      out.push(...chunk);
      if (chunk.length < 100) break;
    }
    return out;
  }
  async function file(p, ref) {
    const r = await req('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    return r && r.content ? fromBase64(r.content) : null;
  }
  return { req, all, file, owner, name, repo, api };
}

export async function collectEvents(gh, number) {
  const [comments, reviews] = await Promise.all([gh.all(`/issues/${number}/comments`), gh.all(`/pulls/${number}/reviews`)]);
  return [
    ...comments.map((c) => ({ login: c.user.login, type: c.user.type, association: c.author_association, body: c.body, createdAt: c.created_at, source: 'comment', id: c.id })),
    ...reviews.filter((r) => r.state !== 'DISMISSED').map((r) => ({ login: r.user.login, type: r.user.type, association: r.author_association, body: r.body, createdAt: r.submitted_at, source: 'review', id: r.id, state: r.state, commitId: r.commit_id })),
  ];
}

const NATIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED']);
// For native GitHub reviews (no /lake line): the plan digest at each reviewed commit.
export async function nativeDigests(gh, events, path, { headSha, headText, config }) {
  const out = {};
  if (config.nativeReviews === false) return out;
  for (const ev of events) {
    if (ev.source !== 'review' || !NATIVE_STATES.has(ev.state) || !ev.commitId || ev.commitId in out || parseCommands(ev.body).length) continue;
    const t = ev.commitId === headSha && headText != null ? headText : await gh.file(path, ev.commitId);
    out[ev.commitId] = t == null ? null : readPlanText(t).digest;
  }
  return out;
}

const isPlanPath = (f) => /^\.lake\/plans\/[^/]+\.md$/.test(f) && !f.endsWith('/README.md');
const isCodePath = (f) => !f.startsWith('.lake/') && !/\.(md|txt)$/i.test(f) && !f.startsWith('docs/');

// Evaluates every plan file touched by the PR. Config is read from the BASE branch so a PR cannot loosen its own policy.
export async function evaluatePr(gh, number) {
  const pr = await gh.req('GET', `/pulls/${number}`);
  const config = parseConfig(await gh.file('.lake/config.json', pr.base.sha));
  const files = await gh.all(`/pulls/${number}/files`);
  const planFiles = files.filter((f) => isPlanPath(f.filename) && f.status !== 'removed').map((f) => f.filename);
  const codeChanged = files.some((f) => isCodePath(f.filename));
  const events = await collectEvents(gh, number);
  const results = [];
  for (const p of planFiles) {
    const text = await gh.file(p, pr.head.sha);
    if (text == null) continue;
    const plan = readPlanText(text, p.split('/').pop().slice(0, -3));
    const estimate = estimatePlan(plan.body, config);
    const digestAt = await nativeDigests(gh, events, p, { headSha: pr.head.sha, headText: text, config });
    const planEvents = expandEvents(events.map((e) => ({ ...e, id: `${e.source}${e.id}` })), { planId: plan.id, digestAt, config });
    results.push({ ...evaluatePlan({ plan, estimate, events: planEvents, prAuthor: pr.user.login, config }), title: plan.title, path: p, estimate });
  }
  return { pr, config, results, codeChanged, repo: gh.repo, ...summarize(results, codeChanged, config) };
}

export function summarize(results, codeChanged, config) {
  if (!results.length) {
    if (!codeChanged || config.requirePlan === 'off') return { state: 'success', description: 'No plan in this PR' };
    return config.requirePlan === 'fail'
      ? { state: 'failure', description: 'Code changed without a plan in .lake/plans/' }
      : { state: 'success', description: 'Warning: code changed without a plan in .lake/plans/' };
  }
  const bad = results.filter((r) => !isPassing(r));
  if (!bad.length) return { state: 'success', description: `${results.length} plan(s) approved for their current version` };
  const r = bad[0];
  return { state: 'failure', description: r.state === 'changes-requested' ? `Changes requested on ${r.id}` : `Waiting for approval: /lake approve ${r.id}@${r.short}`.slice(0, 140) };
}

export function renderSummary(ev) {
  const lines = [MARKER, '### Lake plan gate', ''];
  if (!ev.results.length) { lines.push(ev.description + '.'); return lines.join('\n'); }
  lines.push('| Plan | Version | Status | Complexity | Est. cost |', '|---|---|---|---|---|');
  for (const r of ev.results) {
    const status = r.state === 'approved' ? `approved by ${r.approvers.map((a) => '@' + a).join(', ')}` :
      r.state === 'auto-approved' ? 'auto-approved by policy' :
      r.state === 'changes-requested' ? `changes requested by ${r.blockers.map((a) => '@' + a).join(', ')}` : `needs ${r.needed} approval(s)`;
    lines.push(`| [${r.title.replace(/\|/g, '/')}](${r.path}) | \`${r.short}\` | ${status} | ${r.estimate.complexity} | ${range(r.estimate.usd)} |`);
  }
  const pending = ev.results.filter((r) => !isPassing(r));
  if (pending.length) {
    const base = ev.config?.reviewUrl;
    if (base && ev.repo && ev.pr?.number) {
      const img = (n, alt) => `![${alt}](${base}btn/${n}.svg)`;
      lines.push('', '**Review in one click** (opens the Lake review page for this PR, sign in with GitHub to post):', '');
      for (const r of pending) {
        const link = (act) => `${base}#/pr/${ev.repo}/${ev.pr.number}/${encodeURIComponent(r.id)}${act ? `?do=${act}&v=${r.short}` : ''}`;
        lines.push(`${pending.length > 1 ? `\`${r.id}\` ` : ''}[${img('approve', `Approve v${r.short}`)}](${link('approve')}) [${img('changes', 'Request changes')}](${link('changes')}) [${img('open', 'Open plan review')}](${link('')})`, '');
      }
    }
    if (ev.config?.nativeReviews !== false) lines.push('Or use GitHub\'s own **Review changes → Approve** on this PR. lake-gate counts it for the plan version at the reviewed commit.', '');
    lines.push('Or comment (one line per plan):', '```', ...pending.map((r) => `/lake approve ${r.id}@${r.short}`), '```',
      'Approval is bound to this exact version. Editing the plan file needs a fresh approval.');
  }
  const shadow = ev.results.filter((r) => r.auto.mode === 'shadow' && r.auto.eligible && !isPassing(r));
  if (shadow.length) lines.push('', `Shadow auto-approve: ${shadow.map((r) => r.id).join(', ')} would pass the auto-approve policy. It is in shadow mode, so a human still decides.`);
  const notes = ev.results.flatMap((r) => r.notes);
  if (notes.length) lines.push('', '<details><summary>Ignored commands</summary>', '', ...notes.map((n) => `- ${n}`), '', '</details>');
  return lines.join('\n');
}

export async function publish(gh, ev, { comment = true } = {}) {
  await gh.req('POST', `/statuses/${ev.pr.head.sha}`, { state: ev.state, context: STATUS_CONTEXT, description: ev.description.slice(0, 140) });
  if (!comment || (!ev.results.length && ev.state === 'success' && !/Warning/.test(ev.description))) return;
  const body = renderSummary(ev);
  const existing = (await gh.all(`/issues/${ev.pr.number}/comments`)).find((c) => c.user.type === 'Bot' && String(c.body).startsWith(MARKER));
  if (existing) { if (existing.body !== body) await gh.req('PATCH', `/issues/comments/${existing.id}`, { body }); }
  else await gh.req('POST', `/issues/${ev.pr.number}/comments`, { body });
}

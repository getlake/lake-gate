import { safeParseConfig, withLastValid, configWarning } from './config-core.js';
import { readPlanText } from './plan.js';
import { estimatePlan, range, money, costLabel, autoApproveVerdict } from './estimate.js';
import { evaluatePlan, isPassing, parseCommands } from './policy.js';
import { expandEvents } from './review.js';
import { costSuggestions } from './models.js';

export const STATUS_CONTEXT = 'lake/plan-approval';
export const MARKER = '<!-- lake-gate:summary -->';

// Works in Node and in the browser review UI.
export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export class RateLimitError extends Error {
  constructor(reset, authed) {
    const at = reset ? new Date(reset * 1000) : null;
    super(`GitHub API rate limit reached${authed ? '' : ' (60 requests/hour without a token)'}${at ? `; it resets at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}` : ''}.${authed ? '' : ' Connect a GitHub token to keep going.'}`);
    this.reset = reset; this.authed = authed; this.rateLimited = true;
  }
}
// Plan files and commit lists at a full commit SHA never change: cache them for the life of the client
// (and in `cache`, if given). Everything else is revalidated with ETags (304s), or served from `cache`
// while younger than `freshMs` (the browser app uses this so reloads don't spend the visitor's quota).
const IMMUTABLE = /[?&](ref|sha)=[0-9a-f]{40}(&|$)/;
export function client({ token, repo, api = 'https://api.github.com', fetchImpl = globalThis.fetch, cache = null, freshMs = 0 }) {
  const [owner, name] = repo.split('/');
  const mem = new Map();
  const stats = { requests: 0, cached: 0, notModified: 0 };
  let since = 0; // refresh(): entries read before this are revalidated, not trusted
  async function req(method, url, body) {
    const full = url.startsWith('http') ? url : url.startsWith('~/') ? `${api}${url.slice(1)}` : `${api}/repos/${owner}/${name}${url}`;
    const get = method === 'GET';
    const immutable = get && IMMUTABLE.test(full);
    let hit = get ? (mem.get(full) || cache?.get(full) || null) : null;
    if (hit && (immutable || (freshMs && (hit.at || 0) > since && Date.now() - (hit.at || 0) < freshMs))) { stats.cached++; return hit.data; }
    stats.requests++;
    const res = await fetchImpl(full, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(typeof window === 'undefined' ? { 'User-Agent': 'lake-gate' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(hit?.etag ? { 'If-None-Match': hit.etag } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 304 && hit) { stats.notModified++; hit = { ...hit, at: Date.now() + 1 }; mem.set(full, hit); cache?.set(full, hit); return hit.data; }
    if (res.status === 404 && get) return null;
    if (!res.ok) {
      const text = await res.text();
      const h = (k) => res.headers?.get?.(k);
      if ((res.status === 403 || res.status === 429) && (h('x-ratelimit-remaining') === '0' || /rate limit/i.test(text))) throw new RateLimitError(Number(h('x-ratelimit-reset')) || null, !!token);
      throw new Error(`GitHub ${method} ${url} -> ${res.status} ${text}`);
    }
    const data = res.status === 204 ? null : await res.json();
    if (get) { const e = { data, etag: res.headers?.get?.('etag') || null, at: Date.now() + 1 }; mem.set(full, e); cache?.set(full, e); }
    return data;
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
  // Without a token (public repos in the browser app), file contents come from raw.githubusercontent.com, which
  // doesn't count against the API's 60 calls/hour. Commit-pinned files are cached like API reads.
  const useRaw = !token && api === 'https://api.github.com';
  async function rawFile(p, ref) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${p.split('/').map(encodeURIComponent).join('/')}`;
    const pinned = /^[0-9a-f]{40}$/.test(ref);
    const hit = mem.get(url) || cache?.get(url);
    if (hit && (pinned || (freshMs && (hit.at || 0) > since && Date.now() - hit.at < freshMs))) { stats.cached++; return hit.data; }
    stats.raw = (stats.raw || 0) + 1;
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.status === 404) { const e = { data: null, at: Date.now() + 1 }; if (pinned) { mem.set(url, e); cache?.set(url, e); } return null; }
    if (!res.ok) throw new Error(`GitHub raw ${p}@${ref} -> ${res.status}`);
    const e = { data: await res.text(), at: Date.now() + 1 }; mem.set(url, e); cache?.set(url, e);
    return e.data;
  }
  async function file(p, ref) {
    if (useRaw) { try { return await rawFile(p, ref); } catch { /* fall back to the API */ } }
    const r = await req('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    return r && r.content ? fromBase64(r.content) : null;
  }
  // refresh(): the next reads revalidate instead of trusting fresh cache entries.
  const refresh = () => { since = Date.now() + 2; };
  return { req, all, file, owner, name, repo, api, stats, refresh, authed: !!token };
}

export async function collectEvents(gh, number) {
  const [comments, reviews] = await Promise.all([gh.all(`/issues/${number}/comments`), gh.all(`/pulls/${number}/reviews`)]);
  return [
    ...comments.filter((c) => !String(c.body || '').startsWith(MARKER)).map((c) => ({ login: c.user.login, type: c.user.type, association: c.author_association, body: c.body, createdAt: c.created_at, source: 'comment', id: c.id })),
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

// Budget approvers: logins as listed (recommended). "@org/team" is expanded through the API when the token may
// read the team. An Actions GITHUB_TOKEN usually may not: then we say so in the summary and fall back to any listed
// login or a repo admin (or the repo owner), so a plan never gets stuck on a team nobody can see.
export async function resolveBudgetApprovers(gh, config) {
  const b = config.budget || {};
  if (b.approverAbove == null || !(b.approvers || []).length) return undefined;
  const out = b.approvers.filter((x) => !String(x).includes('/')).map((x) => String(x).replace(/^@/, ''));
  const unreadable = [];
  for (const t of b.approvers.filter((x) => String(x).includes('/'))) {
    const [org, slug] = String(t).replace(/^@/, '').split('/');
    try { out.push(...(await gh.all(`~/orgs/${org}/teams/${slug}/members`)).map((u) => u.login)); } catch { unreadable.push(`@${org}/${slug}`); }
  }
  out.unreadable = unreadable;
  if (unreadable.length) {
    try { out.push(...(await gh.all('/collaborators?permission=admin')).filter((u) => u.permissions?.admin !== false).map((u) => u.login)); out.fallback = 'admins'; }
    catch { out.fallback = 'owner'; } // can't list admins either: the repo owner (OWNER association) counts
  }
  return out;
}

const isPlanPath = (f) => /^\.lake\/plans\/[^/]+\.md$/.test(f) && !f.endsWith('/README.md');
const isCodePath = (f) => !f.startsWith('.lake/') && !/\.(md|txt)$/i.test(f) && !f.startsWith('docs/');

// Lines changed outside .lake/ in a PR: auto-approve only covers small diffs.
export const codeLinesOf = (files) => files.filter((f) => !f.filename.startsWith('.lake/')).reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);

// The team's policy: .lake/config.json at the HEAD of the base branch (pr.base.ref), not at the commit the PR
// branched from, so tightening policy on main applies to open PRs at once. A PR still can't loosen its own policy.
export async function loadBaseConfig(gh, pr) {
  const CFG = '.lake/config.json';
  const ref = pr.base.ref;
  const text = await gh.file(CFG, ref).catch(() => null) ?? await gh.file(CFG, pr.base.sha);
  const c = safeParseConfig(text, `${CFG} on ${ref}`);
  if (!c.configError) return c;
  // A broken policy never loosens the gate: keep the last valid version on the base branch, else fail closed.
  const hist = (await gh.req('GET', `/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(CFG)}&per_page=10`).catch(() => null)) || [];
  for (const h of hist) {
    const r = withLastValid(c, await gh.file(CFG, h.sha).catch(() => null), `${ref} at ${h.sha.slice(0, 7)}`);
    if (r.policyFrom) return r;
  }
  return c;
}

// Did an earlier version of this plan in the PR need a human? Then a shrunk version can't auto-approve.
async function gatedBefore(gh, path, pr, prCommits, config, headDigest) {
  if ((config.autoApprove?.mode || 'off') === 'off') return false;
  const touching = ((await gh.req('GET', `/commits?sha=${encodeURIComponent(pr.head.sha)}&path=${encodeURIComponent(path)}&per_page=20`)) || []).map((c) => c.sha).filter((s) => prCommits.has(s) && s !== pr.head.sha).slice(0, 10);
  for (const sha of touching) {
    const t = await gh.file(path, sha); if (t == null) continue;
    const p = readPlanText(t); if (p.digest === headDigest) continue;
    if (!autoApproveVerdict(estimatePlan(p.body, config), config).eligible) return true;
  }
  return false;
}

// Evaluates every plan file touched by the PR, with the base branch's current policy.
export async function evaluatePr(gh, number) {
  const pr = await gh.req('GET', `/pulls/${number}`);
  const config = await loadBaseConfig(gh, pr);
  const files = await gh.all(`/pulls/${number}/files`);
  const planFiles = files.filter((f) => isPlanPath(f.filename) && f.status !== 'removed').map((f) => f.filename);
  const codeChanged = files.some((f) => isCodePath(f.filename));
  const codeLines = codeLinesOf(files);
  const prCommits = new Set((await gh.all(`/pulls/${number}/commits`)).map((c) => c.sha));
  const events = (await collectEvents(gh, number));
  const budgetApprovers = await resolveBudgetApprovers(gh, config);
  const results = [];
  for (const p of planFiles) {
    const text = await gh.file(p, pr.head.sha);
    if (text == null) continue;
    const plan = readPlanText(text, p.split('/').pop().slice(0, -3));
    const estimate = estimatePlan(plan.body, config);
    const digestAt = await nativeDigests(gh, events, p, { headSha: pr.head.sha, headText: text, config });
    const planEvents = expandEvents(events.map((e) => ({ ...e, id: `${e.source}${e.id}` })), { planId: plan.id, digestAt, config });
    const autoContext = { codeLines, gatedBefore: await gatedBefore(gh, p, pr, prCommits, config, plan.digest) };
    results.push({ ...evaluatePlan({ plan, estimate, events: planEvents, prAuthor: pr.user.login, config, budgetApprovers, autoContext }), title: plan.title, path: p, estimate });
  }
  const sum = config.policyBroken
    ? { state: 'failure', description: `Policy file unreadable: fix .lake/config.json on ${pr.base.ref} ${(config.configError.match(/\(line \d+, column \d+\)/) || [''])[0]}`.trim() }
    : summarize(results, codeChanged, config);
  if (config.policyFrom) sum.description = `.lake/config.json broken, last valid policy kept · ${sum.description}`;
  return { pr, config, results, codeChanged, repo: gh.repo, ...sum };
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
  if (r.state === 'needs-budget') return { state: 'failure', description: `Needs budget approval for ${r.id} (up to ${money(r.budget.exposure)} > ${money(r.budget.threshold)})`.slice(0, 140) };
  return { state: 'failure', description: r.state === 'changes-requested' ? `Changes requested on ${r.id}` : `Waiting for approval: /lake approve ${r.id}@${r.short}`.slice(0, 140) };
}

export function renderSummary(ev) {
  const lines = [MARKER, '### Lake plan gate', ''];
  if (ev.config?.configError) lines.push(`> **${ev.config.policyBroken ? 'Error' : 'Warning'}:** ${configWarning(ev.config)}`, '');
  if (!ev.results.length) { lines.push(ev.description + '.'); return lines.join('\n'); }
  lines.push('| Plan | Version | Status | Complexity | Est. cost |', '|---|---|---|---|---|');
  const autoWhy = [];
  for (const r of ev.results) {
    const status = r.state === 'approved' ? `approved by ${r.approvers.map((a) => '@' + a).join(', ')}` :
      r.state === 'auto-approved' ? 'auto-approved by policy' :
      r.state === 'changes-requested' ? `changes requested by ${r.blockers.map((a) => '@' + a).join(', ')}` :
      r.state === 'needs-budget' ? `approved by ${r.approvers.map((a) => '@' + a).join(', ')}, **needs budget approval**` : `needs ${r.needed} approval(s)${r.budget?.required ? ' + budget approval' : ''}`;
    if (r.auto?.mode !== 'off' && r.auto?.reasons?.length && !isPassing(r)) autoWhy.push(`\`${r.id}\`: ${r.auto.reasons.join('; ')}`);
    const est = r.estimate;
    const cost = `${costLabel(est)}${est.cap != null ? ` (cap ${money(est.cap)})` : ''}`;
    lines.push(`| [${r.title.replace(/\|/g, '/')}](${r.path}) | \`${r.short}\` | ${status} | ${est.complexity} | ${cost} |`);
  }
  if (autoWhy.length) lines.push('', `Not auto-approved (needs a human): ${autoWhy.length === 1 ? autoWhy[0] : ''}`, ...(autoWhy.length > 1 ? autoWhy.map((w) => `- ${w}`) : []));
  for (const r of ev.results.filter((x) => x.budget?.unreadable?.length).slice(0, 1)) {
    lines.push('', `> **Warning:** couldn't read ${r.budget.unreadable.join(', ')} with this token, so ${r.budget.fallback === 'owner' ? 'the repo owner' : 'repo admins'} and any listed login can give the budget approval. List GitHub logins in \`budget.approvers\` (e.g. \`["alice","bob"]\`) to fix this.`);
  }
  for (const r of ev.results.filter((x) => x.budget?.required)) {
    lines.push('', `**Budget approval** for \`${r.id}\`: up to ${money(r.budget.exposure)} is above the team threshold of ${money(r.budget.threshold)}. ${r.budget.satisfied ? `Approved by @${r.budget.approvedBy.join(', @')} for v${r.short}.` : `${(() => { const who = [...r.budget.approvers.map((a) => '@' + a), ...(r.budget.fallback === 'owner' ? ['the repo owner'] : [])]; return who.length === 1 ? who[0] : who.length ? `One of ${who.join(', ')}` : `One of ${r.budget.teams.join(', ')}`; })()} must approve v${r.short} too.`}`);
  }
  for (const r of ev.results) {
    const sugg = costSuggestions(r.estimate, ev.config || {});
    if (sugg.length && !isPassing(r)) lines.push('', `<details><summary>Lake can cut \`${r.id}\` by up to ${money(Math.max(...sugg.map((x) => x.saving[1])))}</summary>`, '', ...sugg.map((x) => `- ${x.title} (saves up to ${money(x.saving[1])})`), '', 'Apply in one click on the Lake review page, or ask your agent (lake_submit_revision).', '', '</details>');
    for (const n of r.estimate.modelNotes || []) lines.push('', `Note on \`${r.id}\`: ${n}`);
  }
  const pending = ev.results.filter((r) => !isPassing(r));
  if (pending.length) {
    const base = ev.config?.reviewUrl;
    if (base && ev.repo && ev.pr?.number) {
      const img = (n, alt) => `![${alt}](${base}btn/${n}.svg)`;
      lines.push('', '**Review in one click** (opens the Lake review page; posting needs a GitHub token the first time):', '');
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
  // Only what concerns the current versions: stale-version commands are expected history, not news.
  const notes = ev.results.flatMap((r) => r.notes.filter((n) => !/refers to version/.test(n)));
  if (notes.length) lines.push('', '<details><summary>Ignored commands</summary>', '', ...notes.map((n) => `- ${n}`), '', '</details>');
  return lines.join('\n');
}

export async function publish(gh, ev, { comment = true } = {}) {
  const target = ev.config?.reviewUrl && ev.repo && ev.pr?.number ? `${ev.config.reviewUrl}#/pr/${ev.repo}/${ev.pr.number}${ev.results[0] ? `/${encodeURIComponent(ev.results[0].id)}` : ''}` : undefined;
  await gh.req('POST', `/statuses/${ev.pr.head.sha}`, { state: ev.state, context: STATUS_CONTEXT, description: ev.description.slice(0, 140), ...(target ? { target_url: target } : {}) });
  if (!comment || (!ev.results.length && ev.state === 'success' && !/Warning/.test(ev.description))) return;
  const body = renderSummary(ev);
  try {
    const existing = (await gh.all(`/issues/${ev.pr.number}/comments`)).find((c) => c.user.type === 'Bot' && String(c.body).startsWith(MARKER));
    if (existing) { if (existing.body !== body) await gh.req('PATCH', `/issues/comments/${existing.id}`, { body }); }
    else await gh.req('POST', `/issues/${ev.pr.number}/comments`, { body });
  } catch (e) {
    // The status check above is what matters. A missing summary comment shouldn't fail the gate.
    console.log(`::warning::lake-gate couldn't post the summary comment (${String(e.message).slice(0, 120)}). Give the workflow "pull-requests: write" (see templates/lake-gate.yml).`);
  }
}

// Reads review state for plans from GitHub PRs and writes review actions back as PR comments.
// Browser-safe: used by the Lake review UI (directly or through `lake-gate ui`'s local proxy) and by the MCP server.
import { parseConfig } from './config-core.js';
import { resolveBudgetApprovers } from './github.js';
import { applyPatch } from './models.js';
import { splitFrontmatter, renderPlanFile, readPlanText } from './plan.js';
import { estimatePlan, renderEstimate } from './estimate.js';
import { buildPlanReview, versionsFromSnapshots, normalizeIssueComment, normalizeReview, normalizeLineComment,
  commentBody, replyBody, resolveBody, verdictBody, suggestionBody, acceptBody } from './review.js';

export const isPlanFile = (f) => /^\.lake\/plans\/[^/]+\.md$/.test(f) && !f.endsWith('/README.md');
const MAX_COMMITS = 60;

export async function loadPr(gh, number, { pr: prIn } = {}) {
  const pr = prIn && prIn.base ? prIn : await gh.req('GET', `/pulls/${number}`);
  const [cfgText, files, commitsAll, comments, reviews, lines] = await Promise.all([
    gh.file('.lake/config.json', pr.base.sha), gh.all(`/pulls/${number}/files`), gh.all(`/pulls/${number}/commits`),
    gh.all(`/issues/${number}/comments`), gh.all(`/pulls/${number}/reviews`), gh.all(`/pulls/${number}/comments`)]);
  const config = parseConfig(cfgText);
  const commits = commitsAll.slice(-MAX_COMMITS);
  const events = [...comments.map(normalizeIssueComment), ...reviews.filter((r) => r.state !== 'DISMISSED' && r.state !== 'PENDING').map(normalizeReview), ...lines.map(normalizeLineComment)];
  const requestedReviewers = (pr.requested_reviewers || []).map((u) => u.login);
  const budgetApprovers = await resolveBudgetApprovers(gh, config);
  const plans = [];
  for (const f of files.filter((x) => isPlanFile(x.filename) && x.status !== 'removed')) {
    const path = f.filename; const fallbackId = path.split('/').pop().slice(0, -3);
    // Which PR commits touched this file? One call, then one content read per touching commit.
    const touching = new Set(((await gh.req('GET', `/commits?sha=${encodeURIComponent(pr.head.sha)}&path=${encodeURIComponent(path)}&per_page=100`)) || []).map((c) => c.sha));
    const snaps = []; const digestAt = {}; let lastText = null;
    for (const c of commits) {
      if (touching.has(c.sha) || lastText === null) {
        const text = await gh.file(path, c.sha);
        if (text != null) { lastText = text; snaps.push({ text, sha: c.sha, at: c.commit?.committer?.date || c.commit?.author?.date || null, author: c.author?.login || c.commit?.author?.name || null }); }
      }
      if (lastText != null) digestAt[c.sha] = versionsFromSnapshots([{ text: lastText }], fallbackId)[0].digest;
    }
    const headText = await gh.file(path, pr.head.sha);
    if (headText == null) continue;
    snaps.push({ text: headText, sha: pr.head.sha, at: commits.at(-1)?.commit?.committer?.date || pr.updated_at, author: pr.user.login });
    const versions = versionsFromSnapshots(snaps, fallbackId);
    const plan = versions.find((v) => v.digest === versionsFromSnapshots([{ text: headText }], fallbackId)[0].digest);
    digestAt[pr.head.sha] = plan.digest;
    plans.push(buildPlanReview({ plan, versions, events, prAuthor: pr.user.login, config, digestAt, pr, requestedReviewers, budgetApprovers }));
  }
  return { pr, config, plans, events };
}

// All plans in recent PRs of a repo (open first). One page of PRs keeps API use predictable.
export async function loadWorkspace(gh, { state = 'all', limit = 20 } = {}) {
  const prs = ((await gh.req('GET', `/pulls?state=${state}&sort=updated&direction=desc&per_page=${limit}`)) || []);
  const out = [];
  for (const pr of prs) {
    const files = await gh.all(`/pulls/${pr.number}/files`);
    if (!files.some((f) => isPlanFile(f.filename) && f.status !== 'removed')) continue;
    const r = await loadPr(gh, pr.number);
    out.push(...r.plans);
  }
  return { repo: gh.repo, plans: out };
}

// ---- Writes: everything is a PR comment (or a reply on a native line comment) ----
async function postIssueComment(gh, number, body) {
  const c = await gh.req('POST', `/issues/${number}/comments`, { body });
  return normalizeIssueComment(c);
}

export const actions = {
  comment: (gh, number, o) => postIssueComment(gh, number, commentBody(o)),
  reply: async (gh, number, o) => {
    if (String(o.thread).startsWith('l')) { // native GitHub line comment thread: reply natively
      const c = await gh.req('POST', `/pulls/${number}/comments/${String(o.thread).slice(1)}/replies`, { body: o.text });
      return normalizeLineComment({ ...c, in_reply_to_id: c.in_reply_to_id || Number(String(o.thread).slice(1)) });
    }
    return postIssueComment(gh, number, replyBody(o));
  },
  resolve: (gh, number, o) => postIssueComment(gh, number, resolveBody(o)),
  verdict: (gh, number, o) => postIssueComment(gh, number, verdictBody(o)),
  suggest: (gh, number, o) => postIssueComment(gh, number, suggestionBody(o)),
  // Author accepts a suggestion: commit the patched plan file to the PR branch, then mark the thread accepted.
  accept: async (gh, number, o) => {
    const pr = await gh.req('GET', `/pulls/${number}`);
    const path = `.lake/plans/${o.planId}.md`;
    const cur = await gh.req('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(pr.head.ref)}`);
    if (!cur) throw new Error(`${path} not found on ${pr.head.ref}`);
    const config = parseConfig(await gh.file('.lake/config.json', pr.base.sha));
    const text = patchPlanFile(fromB64(cur.content), o.patch, config);
    await gh.req('PUT', `/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { message: `Plan ${o.planId}: ${o.title || 'apply suggestion'}`, content: toB64(text), sha: cur.sha, branch: pr.head.ref });
    const nv = readPlanText(text).digest;
    return postIssueComment(gh, number, acceptBody({ ...o, newVersion: nv }));
  },
};

// The whole plan file with a suggestion applied and its estimate block regenerated.
export function patchPlanFile(fileText, patch, config) {
  const { meta, body } = splitFrontmatter(fileText);
  const next = applyPatch(body.replace(/<!-- lake:estimate:start[\s\S]*?<!-- lake:estimate:end -->\n?/, '').replace(/\s+$/, '') + '\n', patch);
  return renderPlanFile({ id: meta.id, title: meta.title || readPlanText(fileText).title, author: meta.author, source: meta.source, created: meta.created, body: next, estimateMd: renderEstimate(estimatePlan(next, config), config) });
}
const fromB64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(String(b).replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const toB64 = (t) => { const u = new TextEncoder().encode(t); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

export async function viewer(gh) {
  try { return await gh.req('GET', '~/user'); } catch { return null; }
}

// Review model: plan versions (rounds), anchored comment threads, verdicts and an activity timeline.
// Pure and browser-safe. The source of truth stays on the PR: every comment, reply, resolve and verdict
// is an ordinary PR comment carrying a small hidden marker, so it survives without any Lake server and
// is readable by humans on GitHub. Native GitHub line comments on the plan file and native PR reviews
// (Approve / Request changes) are mapped into the same model.
import { readPlanText, splitFrontmatter, stripEstimate } from './plan.js';
import { estimatePlan } from './estimate.js';
import { costSuggestions, modelOptions } from './models.js';
import { evaluatePlan, parseCommands } from './policy.js';

const MARK = /<!--\s*lake:(c|resolve|v|proxy)\s+(\{[\s\S]*?\})\s*-->/g;
export const PROXY_LOGIN = 'github-actions[bot]';

export function encodeMarker(kind, data) {
  // "--" can't appear inside an HTML comment; JSON-escape it.
  return `<!-- lake:${kind} ${JSON.stringify(data).replace(/--/g, '\\u002d\\u002d')} -->`;
}

export function parseMarkers(body) {
  const out = [];
  for (const m of String(body || '').matchAll(MARK)) {
    try { out.push({ kind: m[1], data: JSON.parse(m[2]) }); } catch { /* ignore broken marker */ }
  }
  return out;
}

const CMD_LINE = /^\s*\/lake\s+(approve|reject|revoke)\b.*$/gim;
// Human text of a comment: no markers, no /lake command lines, no quoted anchor preview we generated.
export function messageOf(body) {
  return String(body || '').replace(MARK, '').replace(CMD_LINE, '')
    .replace(/^<sub>.*lake-gate.*<\/sub>$/gim, '')
    .replace(/^\*\*(Comment on|Reply on|Resolved|Reopened|Suggestion on|Accepted suggestion) [^\n]*\*\*.*$/gim, '')
    .replace(/^>.*$/gm, '').trim();
}

// One vocabulary for plan status across the review app, the CLI and MCP.
export const STATUS_LABELS = { 'in-review': 'In review', pending: 'In review', 'changes-requested': 'Changes requested', approved: 'Approved', 'needs-budget': 'Needs budget OK', 'auto-approved': 'Auto-approved', draft: 'Draft', 'approved-then-edited': 'Approved, then edited', superseded: 'Superseded' };
export const statusLabel = (st) => STATUS_LABELS[st] || st;
export const shortOf = (d) => String(d || '').slice(0, 8);
export function newId(n = 8) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const quoteBlock = (q) => String(q || '').split('\n').slice(0, 4).map((l) => `> ${l}`).join('\n');
const footer = (via) => `<sub>via lake-gate${via ? ` · ${via}` : ''}</sub>`;

// ---- Bodies that the UI, the MCP server and the CLI post to the PR ----
export function commentBody({ planId, version, anchor, text, thread = newId(), via }) {
  const where = anchor?.heading ? ` · ${anchor.heading}` : anchor ? ` · line ${anchor.start}${anchor.end > anchor.start ? `–${anchor.end}` : ''}` : '';
  return [`**Comment on \`${planId}\` v${shortOf(version)}${where}**`, anchor?.quote ? quoteBlock(anchor.quote) : null, '', String(text).trim(), '', footer(via),
    encodeMarker('c', { p: planId, v: shortOf(version), t: thread, ...(anchor ? { a: { s: anchor.start, e: anchor.end || anchor.start, q: String(anchor.quote || '').slice(0, 300), h: anchor.heading || undefined } } : {}) })]
    .filter((x) => x !== null).join('\n');
}
// A structured suggestion (model change, cheaper steps, cap, drop a step). The author applies it in one click,
// which commits a new plan version; the thread then shows as accepted.
export function suggestionBody({ planId, version, title, patch, saving, text, thread = newId(), via, anchor }) {
  const save = saving && saving[1] > 0.005 ? ` · saves up to $${saving[1] < 10 ? saving[1].toFixed(2) : Math.round(saving[1])}` : '';
  return [`**Suggestion on \`${planId}\` v${shortOf(version)}: ${String(title).replace(/\*/g, '')}**${save}`, '', text ? String(text).trim() : null, text ? '' : null, footer(via),
    encodeMarker('c', { p: planId, v: shortOf(version), t: thread, s: { title: String(title).slice(0, 140), patch, save: saving || null }, ...(anchor ? { a: { s: anchor.start, e: anchor.end || anchor.start, q: String(anchor.quote || '').slice(0, 300) } } : {}) })]
    .filter((x) => x !== null).join('\n');
}
export function acceptBody({ planId, thread, title, newVersion, via }) {
  return [`**Accepted suggestion on \`${planId}\`: ${String(title || '').replace(/\*/g, '')}** → v${shortOf(newVersion)}`, '', 'This is a new plan version, so earlier approvals no longer apply.', '', footer(via),
    encodeMarker('resolve', { p: planId, t: thread, r: true, acc: 1, nv: shortOf(newVersion) })].join('\n');
}
export function replyBody({ planId, thread, text, via }) {
  return [`**Reply on \`${planId}\`**`, '', String(text).trim(), '', footer(via), encodeMarker('c', { p: planId, t: thread, re: 1 })].join('\n');
}
export function resolveBody({ planId, thread, resolved = true, text, via }) {
  return [`**${resolved ? 'Resolved' : 'Reopened'} a thread on \`${planId}\`**`, text ? `\n${String(text).trim()}` : null, '', footer(via), encodeMarker('resolve', { p: planId, t: thread, r: resolved })]
    .filter((x) => x !== null).join('\n');
}
// approve | reject. The /lake line is what lake-gate's policy counts; the rest is the reviewer's note.
export function verdictBody({ action, planId, version, text, via, resolves = [] }) {
  const cmd = action === 'approve' ? 'approve' : 'reject';
  return [`/lake ${cmd} ${planId}@${shortOf(version)}`, text && String(text).trim() ? `\n${String(text).trim()}` : null, '', footer(via),
    via ? encodeMarker('v', { via }) : null, ...resolves.map((t) => encodeMarker('resolve', { p: planId, t, r: true }))].filter((x) => x !== null).join('\n');
}

// ---- Normalizing GitHub REST objects ----
export function normalizeIssueComment(c) {
  return { id: `c${c.id}`, ghId: c.id, source: 'comment', login: c.user.login, type: c.user.type, association: c.author_association, body: c.body || '', createdAt: c.created_at, url: c.html_url };
}
export function normalizeReview(r) {
  return { id: `r${r.id}`, ghId: r.id, source: 'review', login: r.user.login, type: r.user.type, association: r.author_association, body: r.body || '', createdAt: r.submitted_at, state: r.state, commitId: r.commit_id, url: r.html_url };
}
export function normalizeLineComment(c) {
  return { id: `l${c.id}`, ghId: c.id, source: 'line', login: c.user.login, type: c.user.type, association: c.author_association, body: c.body || '', createdAt: c.created_at,
    path: c.path, line: c.line ?? c.original_line, startLine: c.start_line ?? c.original_start_line ?? null, commitId: c.original_commit_id || c.commit_id, inReplyTo: c.in_reply_to_id ? `l${c.in_reply_to_id}` : null, url: c.html_url };
}

// One plan file at one commit.
export function versionFromText(text, { sha = null, at = null, author = null, fallbackId } = {}) {
  const p = readPlanText(text, fallbackId);
  const fm = String(text).replace(/\r\n?/g, '\n').match(/^---\n[\s\S]*?\n---\n?/);
  return { id: p.id, title: p.title, digest: p.digest, short: p.short, body: p.body, meta: p.meta, offset: fm ? fm[0].split('\n').length - 1 : 0, sha, at, author };
}

// Chronological unique versions from a list of {text, sha, at, author} snapshots.
export function versionsFromSnapshots(snaps, fallbackId) {
  const out = [];
  for (const s of snaps) {
    if (s.text == null) continue;
    const v = versionFromText(s.text, { ...s, fallbackId });
    if (!out.length || out[out.length - 1].digest !== v.digest) {
      if (!out.some((o) => o.digest === v.digest)) out.push(v);
    }
  }
  return out;
}

const NATIVE = { APPROVED: 'approve', CHANGES_REQUESTED: 'reject' };

// Makes the event list policy-ready for ONE plan:
// - a native GitHub review (Approve / Request changes) without a /lake line counts for the plan version at the reviewed commit;
// - a check-button click relayed by the Action (bot comment with a proxy marker) counts as the clicking user.
export function expandEvents(events, { planId, digestAt = {}, config = {} }) {
  const out = [];
  for (const ev of events) {
    if (ev.source === 'line') continue;
    let e = ev;
    const proxy = parseMarkers(ev.body).find((m) => m.kind === 'proxy');
    if (proxy && ev.login === PROXY_LOGIN && ev.type === 'Bot' && proxy.data.by) {
      e = { ...ev, login: proxy.data.by, type: 'User', association: proxy.data.assoc || 'NONE', via: 'GitHub check button' };
    }
    if (config.nativeReviews !== false && ev.source === 'review' && NATIVE[ev.state] && !parseCommands(ev.body).length) {
      const d = ev.commitId && digestAt[ev.commitId];
      if (d) e = { ...e, body: `/lake ${NATIVE[ev.state]} ${planId}@${d}\n${ev.body || ''}`, via: 'GitHub review', native: true };
    }
    out.push(e);
  }
  return out;
}

// ---- Diff ----
export function lineDiff(a, b) {
  const A = clean(a).split('\n'); const B = clean(b).split('\n');
  const n = A.length; const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: 'same', text: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: 'del', text: A[i], a: i + 1 }); i++; }
    else { out.push({ op: 'add', text: B[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ op: 'del', text: A[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ op: 'add', text: B[j], b: j + 1 }); j++; }
  return out;
}
function clean(body) { return stripEstimate(String(body)).replace(/\s+$/, ''); }

// Word-level spans for a changed line pair: [{op:'same'|'add'|'del', text}]
export function wordDiff(a, b) {
  const A = a.split(/(\s+)/); const B = b.split(/(\s+)/);
  const n = A.length; const m = B.length;
  if (n * m > 40000) return [{ op: 'del', text: a }, { op: 'add', text: b }];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  const push = (op, text) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += text; else out.push({ op, text }); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { push('del', A[i]); i++; } else { push('add', B[j]); j++; }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

export function diffStats(diff) {
  return { added: diff.filter((d) => d.op === 'add').length, removed: diff.filter((d) => d.op === 'del').length };
}

// Where does an anchor (from an older version) land in another version's body? null = outdated.
export function relocateAnchor(anchor, body) {
  if (!anchor) return null;
  const lines = String(body).split('\n');
  const q = String(anchor.quote || '').trim();
  if (!q) return anchor.start <= lines.length ? { start: anchor.start, end: anchor.end } : null;
  const first = q.split('\n')[0].trim().replace(/^([-*+]|\d+[.)])\s+/, '');
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(first)) hits.push(i + 1); });
  if (!hits.length) return null;
  const best = hits.reduce((a, h) => (Math.abs(h - anchor.start) < Math.abs(a - anchor.start) ? h : a), hits[0]);
  return { start: best, end: best + (anchor.end - anchor.start) };
}

function headingFor(body, line) {
  const lines = String(body).split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) { const m = lines[i].match(/^#{1,4}\s+(.+)$/); if (m) return m[1].trim(); }
  return null;
}

// ---- The model ----
// plan: current plan ({id, title, body, digest, short, meta}); versions: chronological [{digest, body, at, sha, author, offset}]
// events: normalized events (comments, reviews, line comments); digestAt: {commitSha: digest} for this plan's file
export function buildPlanReview({ plan, versions = [], events = [], prAuthor = null, config, digestAt = {}, pr = null, requestedReviewers = [], budgetApprovers, autoContext }) {
  const vs = versions.length ? [...versions] : [];
  if (!vs.some((v) => v.digest === plan.digest)) vs.push({ ...plan, offset: plan.offset || 0, at: plan.at || null, author: plan.author || null });
  const byPrefix = (p) => (p ? vs.find((v) => v.digest.startsWith(String(p).toLowerCase())) : null);
  const vIndex = (d) => vs.findIndex((v) => v.digest === d);
  const current = vs[vIndex(plan.digest)];
  const estimate = estimatePlan(plan.body, config);
  const expanded = expandEvents(events, { planId: plan.id, digestAt, config });
  const policy = evaluatePlan({ plan, estimate, events: expanded, prAuthor, config, budgetApprovers, autoContext });
  const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const expandedById = new Map(expanded.map((e) => [e.id, e]));

  const verdicts = []; const threads = new Map(); const timeline = []; const resolves = [];
  const planPath = `.lake/plans/${plan.id}.md`;

  for (const raw of sorted) {
    const ev = expandedById.get(raw.id) || raw;
    const markers = parseMarkers(raw.body);
    const viaMarker = markers.find((m) => m.kind === 'v');
    // verdicts
    for (const c of parseCommands(ev.body)) {
      if (c.id !== plan.id) continue;
      const v = byPrefix(c.digest);
      const item = { login: ev.login, action: c.action, version: v ? v.digest : null, short: v ? v.short : shortOf(c.digest), n: v ? vIndex(v.digest) + 1 : null,
        text: messageOf(raw.body), at: ev.createdAt, via: ev.via || viaMarker?.data.via || (raw.source === 'review' ? 'GitHub review' : 'PR comment'),
        self: !!(prAuthor && ev.login.toLowerCase() === prAuthor.toLowerCase()), bot: ev.type === 'Bot', url: raw.url, eventId: raw.id };
      verdicts.push(item);
      timeline.push({ kind: c.action, login: item.login, at: item.at, short: item.short, n: item.n, text: item.text, via: item.via, self: item.self });
    }
    // Lake marker threads
    for (const m of markers) {
      if (m.data.p !== plan.id) continue;
      if (m.kind === 'c' && !m.data.re && m.data.t) {
        const v = byPrefix(m.data.v) || current;
        const a = m.data.a ? { start: m.data.a.s, end: m.data.a.e ?? m.data.a.s, quote: m.data.a.q || '', heading: m.data.a.h || headingFor(v.body, m.data.a.s) } : null;
        threads.set(m.data.t, { id: m.data.t, version: v.digest, short: v.short, n: vIndex(v.digest) + 1, anchor: a, comments: [], resolved: false, resolvedBy: null, source: 'lake',
          suggestion: m.data.s ? { title: String(m.data.s.title || ''), patch: m.data.s.patch, saving: m.data.s.save || null, by: raw.login, accepted: false } : null });
        threads.get(m.data.t).comments.push({ login: raw.login, text: messageOf(raw.body), at: raw.createdAt, id: raw.id, url: raw.url });
        timeline.push({ kind: 'comment', login: raw.login, at: raw.createdAt, short: v.short, n: vIndex(v.digest) + 1, text: messageOf(raw.body), thread: m.data.t, where: a?.heading || null });
      } else if (m.kind === 'c' && m.data.re && threads.has(m.data.t)) {
        threads.get(m.data.t).comments.push({ login: raw.login, text: messageOf(raw.body), at: raw.createdAt, id: raw.id, url: raw.url });
        timeline.push({ kind: 'reply', login: raw.login, at: raw.createdAt, text: messageOf(raw.body), thread: m.data.t });
      } else if (m.kind === 'resolve') {
        resolves.push({ t: m.data.t, r: m.data.r !== false, login: raw.login, at: raw.createdAt, acc: !!m.data.acc, nv: m.data.nv || null });
      }
    }
    // Native GitHub line comments on the plan file
    if (raw.source === 'line' && raw.path === planPath) {
      if (!raw.inReplyTo) {
        const v = (raw.commitId && byPrefix(digestAt[raw.commitId])) || current;
        const start = Math.max(1, (raw.startLine || raw.line) - (v.offset || 0)); const end = Math.max(start, raw.line - (v.offset || 0));
        const quote = String(v.body).split('\n').slice(start - 1, end).join('\n');
        threads.set(raw.id, { id: raw.id, version: v.digest, short: v.short, n: vIndex(v.digest) + 1, anchor: { start, end, quote, heading: headingFor(v.body, start) }, comments: [], resolved: false, resolvedBy: null, source: 'github' });
        timeline.push({ kind: 'comment', login: raw.login, at: raw.createdAt, short: v.short, n: vIndex(v.digest) + 1, text: raw.body, thread: raw.id, where: headingFor(v.body, start) });
      } else if (threads.has(raw.inReplyTo)) timeline.push({ kind: 'reply', login: raw.login, at: raw.createdAt, text: raw.body, thread: raw.inReplyTo });
      const t = threads.get(raw.inReplyTo || raw.id);
      if (t) t.comments.push({ login: raw.login, text: raw.body, at: raw.createdAt, id: raw.id, url: raw.url });
    }
  }
  for (const r of resolves) {
    const t = threads.get(r.t); if (!t) continue;
    t.resolved = r.r; t.resolvedBy = r.r ? r.login : null; t.resolvedAt = r.r ? r.at : null;
    if (t.suggestion && r.acc) { t.suggestion = { ...t.suggestion, accepted: true, acceptedBy: r.login, newVersion: r.nv }; timeline.push({ kind: 'accept', login: r.login, at: r.at, thread: r.t, text: t.suggestion.title, short: r.nv }); continue; }
    timeline.push({ kind: r.r ? 'resolve' : 'reopen', login: r.login, at: r.at, thread: r.t });
  }
  // Where each thread sits on the current version
  const allThreads = [...threads.values()].map((t) => {
    if (t.version === plan.digest) return { ...t, outdated: false, current: t.anchor ? { start: t.anchor.start, end: t.anchor.end } : null };
    const loc = relocateAnchor(t.anchor, plan.body);
    return { ...t, outdated: !loc && !!t.anchor, current: loc };
  });
  for (const v of vs) timeline.push({ kind: 'version', login: v.author || null, at: v.at, short: v.short, n: vIndex(v.digest) + 1 });
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  // Reviewers: latest verdict per person; people asked to review but silent are "waiting"
  const reviewers = new Map();
  for (const r of requestedReviewers) reviewers.set(r, { login: r, verdict: 'waiting', at: null, current: false });
  for (const v of verdicts) {
    if (v.self || v.bot) continue;
    if (v.action === 'revoke') { reviewers.set(v.login, { login: v.login, verdict: 'revoked', at: v.at, current: false }); continue; }
    reviewers.set(v.login, { login: v.login, verdict: v.action === 'approve' ? 'approved' : 'changes-requested', at: v.at, short: v.short, n: v.n, current: v.version === plan.digest, text: v.text, via: v.via });
  }
  if (policy.budget?.required) {
    for (const b of policy.budget.approvers) {
      if (prAuthor && b.toLowerCase() === prAuthor.toLowerCase()) continue;
      const r = reviewers.get(b);
      reviewers.set(b, { ...(r || { login: b, verdict: 'waiting', at: null, current: false }), budget: true });
    }
  }
  for (const t of allThreads) for (const c of t.comments) {
    if (c.login === prAuthor) continue;
    const r = reviewers.get(c.login);
    if (!r) reviewers.set(c.login, { login: c.login, verdict: 'commented', at: c.at, current: false });
    else if (r.verdict === 'waiting') reviewers.set(c.login, { ...r, verdict: 'commented', at: c.at });
  }

  const rounds = vs.map((v, i) => {
    const vv = verdicts.filter((x) => x.version === v.digest);
    const isCur = v.digest === plan.digest;
    let outcome = isCur ? policy.state : vv.some((x) => x.action === 'reject') ? 'changes-requested' : vv.some((x) => x.action === 'approve') ? 'approved-then-edited' : 'superseded';
    if (isCur && outcome === 'pending' && pr?.draft) outcome = 'draft';
    const prev = vs[i - 1];
    return { n: i + 1, digest: v.digest, short: v.short, at: v.at, author: v.author, sha: v.sha, current: isCur, verdicts: vv,
      threads: allThreads.filter((t) => t.version === v.digest), estimate: estimatePlan(v.body, config), outcome, body: v.body,
      stats: prev ? diffStats(lineDiff(prev.body, v.body)) : null };
  });

  const passing = policy.state === 'approved' || policy.state === 'auto-approved';
  const status = passing ? policy.state : policy.state === 'changes-requested' ? 'changes-requested' : (!pr || pr.draft) ? 'draft' : policy.state === 'needs-budget' ? 'needs-budget' : 'in-review';
  const last = timeline.filter((t) => t.at).slice(-1)[0];
  return {
    id: plan.id, title: plan.title, path: planPath, digest: plan.digest, short: plan.short, body: plan.body, meta: plan.meta || {},
    author: prAuthor || plan.meta?.author || null, pr: pr ? { number: pr.number, title: pr.title, url: pr.html_url, draft: !!pr.draft, state: pr.merged_at ? 'merged' : pr.state, branch: pr.head?.ref } : null,
    status, policy, estimate, rounds, round: rounds.length, threads: allThreads, verdicts, timeline, reviewers: [...reviewers.values()],
    openThreads: allThreads.filter((t) => !t.resolved && !t.outdated).length, lastActivity: last ? last.at : null,
    approveLine: `/lake approve ${plan.id}@${plan.short}`,
    suggestions: costSuggestions(estimate, config).filter((x) => !allThreads.some((t) => t.suggestion && !t.resolved && t.version === plan.digest && JSON.stringify(t.suggestion.patch) === JSON.stringify(x.patch))),
    modelOptions: modelOptions(estimate, config),
    budget: policy.budget,
  };
}

export function sectionText(body) { return stripEstimate(String(body)); }
export { splitFrontmatter };

// Lake review: plans, inline comments, review rounds and one-click verdicts for lake-gate.
import { parseBlocks, outline, esc, inline } from './md.js';
import { lineDiff, wordDiff, diffStats } from './core/review.js';
import { range, money } from './core/estimate.js';
import { demoSource, githubSource, localSource, tokenStore } from './data.js';

const $app = document.getElementById('app');
const S = { src: null, ws: null, base: null, err: null, filter: 'all', q: '', sel: 0, tfilter: 'open', compose: null, sheet: null, focus: null, help: false, handled: new Set(), expand: false, openThreads: new Set() };
let route = {};

// ---------- utils ----------
const icon = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const PAL = ['#0e7c7b', '#3f8f86', '#5a7fa6', '#b07d3a', '#7a6aa6', '#4c8b5f', '#a0566b', '#2f6f8f'];
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const person = (l) => (S.ws?.people?.[l]?.name) || l || 'someone';
const first = (l) => person(l).split(' ')[0];
const initials = (l) => { const n = person(l).split(/\s+/); return ((n[0]?.[0] || '?') + (n[1]?.[0] || '')).toUpperCase(); };
function avatar(l, cls = '', badge = '') {
  const b = badge ? `<span class="badge ${badge}">${icon({ ok: 'check', bad: 'x', wait: 'clock', com: 'msg' }[badge])}</span>` : '';
  return `<span class="av ${cls}" style="background:${PAL[hash(l) % PAL.length]}" title="${esc(person(l))}" aria-hidden="true">${esc(initials(l))}${b}</span>`;
}
function rel(at) {
  if (!at) return '';
  const d = (Date.now() - new Date(at).getTime()) / 60000;
  if (d < 1) return 'just now'; if (d < 60) return `${Math.round(d)}m ago`; if (d < 60 * 24) return `${Math.round(d / 60)}h ago`;
  if (d < 60 * 48) return 'yesterday'; if (d < 60 * 24 * 7) return `${Math.round(d / 1440)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const STATUS = { 'in-review': ['In review', 'clock'], 'changes-requested': ['Changes requested', 'undo'], approved: ['Approved', 'check'], 'needs-budget': ['Needs budget OK', 'coin'], 'auto-approved': ['Auto-approved', 'check'], draft: ['Draft', 'pause'], pending: ['In review', 'clock'], 'approved-then-edited': ['Approved, then edited', 'layers'], superseded: ['Superseded', 'layers'] };
const chip = (st) => `<span class="chip st-${st === 'pending' ? 'in-review' : st}">${icon(STATUS[st]?.[1] || 'dot', 'xs')}${STATUS[st]?.[0] || st}</span>`;
const costOf = (est) => (est.declared ? est.plannedUsd : est.usd);
const overridden = (est) => (est.declared ? est.steps.filter((s) => s.planned && s.planned.name !== est.model?.name).length : 0);
const short = (n) => String(n || '').replace(/^Claude /, '');
const VERDICT_BADGE = { approved: 'ok', 'changes-requested': 'bad', waiting: 'wait', commented: 'com', revoked: 'wait' };
const viaIcon = (v) => (String(v).includes('MCP') ? icon('bot', 'xs') : String(v).includes('GitHub') ? icon('gh', 'xs') : '');
const viewer = () => S.ws?.viewer || null;
const go = (h) => { if (location.hash !== h) location.hash = h; else render(); };
const planHref = (p, sub = '') => `${S.base}/plan/${encodeURIComponent(p.id)}${p.pr ? `~${p.pr.number}` : ''}${sub}`;
function toast(msg, ic = 'check') {
  const t = document.getElementById('toast');
  t.innerHTML = `<div class="t">${icon(ic)}<span>${msg}</span></div>`;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.innerHTML = ''; }, 3200);
}
const track = (path) => { try { window.goatcounter?.count?.({ path: `app-${path}`, title: path, event: true }); } catch { /* none */ } };

function needsMe(p) {
  const me = viewer();
  if (me && p.status === 'needs-budget' && p.budget?.approvers?.includes(me) && p.author !== me) return true;
  if (!me || p.status !== 'in-review' || p.author === me) return false;
  const r = p.reviewers.find((x) => x.login === me);
  return !(r && r.current && (r.verdict === 'approved' || r.verdict === 'changes-requested'));
}
const myVerdict = (p) => { const r = p.reviewers.find((x) => x.login === viewer()); return r && r.current ? r.verdict : null; };
const planKey = (p) => `${p.id}~${p.pr?.number || ''}`;
const findPlanById = (k) => S.ws?.plans.find((p) => planKey(p) === k);
function headingAt(body, line) {
  const ls = String(body).split('\n');
  for (let i = line - 1; i >= 0; i--) { const m = ls[i]?.match(/^#{1,4}\s+(.+)$/); if (m) return m[1].trim(); }
  return null;
}

// ---------- scene art (original, palette-only) ----------
function scene(id = 's', align = 'xMidYMid') {
  const trees = [[470, 176, 1], [492, 172, 0.8], [512, 180, 1.1], [540, 174, 0.9]].map(([x, y, s]) => `<path d="M${x} ${y} l${10 * s} ${-34 * s} l${10 * s} ${34 * s}z M${x + 3 * s} ${y - 14 * s} l${7 * s} ${-26 * s} l${7 * s} ${26 * s}z"/>`).join('');
  return `<svg viewBox="0 0 600 300" preserveAspectRatio="${align} slice" aria-hidden="true">
  <defs><linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7fbf9"/><stop offset="1" stop-color="#dcefe9"/></linearGradient>
  <linearGradient id="${id}w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a7dbd3"/><stop offset="1" stop-color="#4cb7b1"/></linearGradient></defs>
  <rect width="600" height="300" fill="url(#${id}sky)"/><circle cx="455" cy="92" r="40" fill="#fbefd2"/>
  <path d="M0 170 C90 120 170 132 250 150 S420 120 600 140 V300 H0Z" fill="#cde8e1"/>
  <path d="M0 190 C120 150 230 168 330 178 S510 150 600 168 V300 H0Z" fill="#a9d6cc"/>
  <g fill="#5d9f93">${trees}</g>
  <path d="M0 205 H600 V300 H0Z" fill="url(#${id}w)"/>
  <g stroke="#f1f7f6" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".85"><path d="M60 232 c30-8 60 8 90 0 s60-8 90 0"/><path d="M300 254 c30-8 60 8 90 0 s60-8 90 0"/><path d="M150 278 c22-6 44 6 66 0"/></g>
  <g fill="none" stroke="#0e7c7b" stroke-width="1.6" opacity=".5"><ellipse cx="400" cy="236" rx="18" ry="4"/><ellipse cx="400" cy="236" rx="34" ry="8" opacity=".6"/><ellipse cx="400" cy="236" rx="52" ry="12" opacity=".3"/></g></svg>`;
}

// ---------- routing ----------
function parseRoute() {
  const h = decodeURIComponent(location.hash || '');
  const [path, qs] = h.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  let m;
  if ((m = path.match(/^#\/pr\/([^/]+)\/([^/]+)\/(\d+)\/(.+)$/))) return { base: `#/r/${m[1]}/${m[2]}`, mode: 'github', view: 'plan', tab: 'plan', id: m[4], pr: Number(m[3]), q, repo: `${m[1]}/${m[2]}` };
  let base; let rest; let repo = null; let mode;
  if ((m = path.match(/^#\/demo(.*)$/))) { base = '#/demo'; rest = m[1]; mode = 'demo'; }
  else if ((m = path.match(/^#\/local(.*)$/))) { base = '#/local'; rest = m[1]; mode = 'local'; }
  else if ((m = path.match(/^#\/r\/([^/]+)\/([^/]+)(.*)$/))) { base = `#/r/${m[1]}/${m[2]}`; rest = m[3]; repo = `${m[1]}/${m[2]}`; mode = 'github'; }
  else if (path === '#/connect') return { view: 'connect', q };
  else return { view: 'root', q };
  const r = { base, mode, repo, q };
  if ((m = rest.match(/^\/plan\/([^/~]+)(?:~(\d+))?(\/.*)?$/))) {
    Object.assign(r, { view: 'plan', id: m[1], pr: m[2] ? Number(m[2]) : null, tab: 'plan' });
    const sub = m[3] || ''; let d;
    if (sub === '/rounds') r.tab = 'rounds';
    else if (sub === '/activity') r.tab = 'activity';
    else if ((d = sub.match(/^\/diff(?:\/(\d+)\/(\d+))?$/))) { r.tab = 'diff'; r.a = d[1] ? Number(d[1]) : null; r.b = d[2] ? Number(d[2]) : null; }
  } else if (rest === '/activity') r.view = 'activity';
  else if (rest === '/needs') { r.view = 'dash'; r.filter = 'needs'; }
  else r.view = 'dash';
  return r;
}
function friendly(m) {
  if (/rate limit/i.test(m) && !/-> \d/.test(m)) return m; // our own clear message (with the reset time)
  if (/-> 401/.test(m)) return 'GitHub rejected the token. Check it and try again.';
  if (/-> 403/.test(m)) return 'GitHub refused (rate limit or missing permission). A token fixes the rate limit.';
  if (/-> 404|Not Found/.test(m)) return 'Repository not found. Private repos need a token with access.';
  return m;
}
async function ensureSource(r) {
  if (S.base === r.base && S.src) {
    // Opened from a PR deep link without a token (one PR read), now browsing the repo: read the rest.
    if (S.ws?.partial && r.view !== 'plan') { renderLoading(); try { S.ws = await S.src.load(); } catch (e) { toast(esc(friendly(e.message)), 'x'); } }
    return;
  }
  S.base = r.base; S.ws = null; S.err = null; S.sel = 0;
  try {
    if (r.mode === 'demo') { S.src = demoSource(); track('demo'); }
    else if (r.mode === 'local') { S.src = await localSource(); if (!S.src) throw new Error('Local mode needs `npx lake-gate ui`.'); }
    else { S.src = githubSource(r.repo); track('repo'); }
    renderLoading();
    S.ws = await S.src.load({ focus: r.mode === 'github' && r.view === 'plan' ? r.pr : null });
  } catch (e) {
    S.err = e.message || String(e);
    if (r.mode === 'github') { S.src = null; S.base = null; go(`#/connect?repo=${encodeURIComponent(r.repo || '')}&err=${encodeURIComponent(friendly(S.err))}`); }
  }
}
function renderLoading() {
  $app.innerHTML = '<div class="loading"><div class="loader"><span></span><span></span><span></span></div><div>Reading plans and reviews…</div></div>';
}

// ---------- shell ----------
function rail() {
  const plans = S.ws?.plans || [];
  const needs = plans.filter(needsMe).length;
  const cur = route.view === 'activity' ? 'activity' : route.filter === 'needs' ? 'needs' : 'plans';
  const isDemo = S.src?.mode === 'demo';
  const repoLabel = S.src?.repo || '';
  const a = (href, key, ic, label, count) => `<a href="${href}" ${cur === key ? 'aria-current="page"' : ''}>${icon(ic)}${label}${count}</a>`;
  return `
  <aside class="rail" aria-label="Navigation">
    <a class="brand" href="${S.base}"><img src="logo-mark.svg" alt="" data-act="boat"><span>Lake<span class="dot">.</span></span><span class="tag">review</span></a>
    <a class="repo" href="#/connect" title="Switch repository"><span class="sq">${esc((repoLabel.split('/')[0] || 'L')[0].toUpperCase())}</span><span><b>${esc(repoLabel)}</b><small>${isDemo ? 'Demo · fictional team' : S.src?.mode === 'local' ? 'Local · your checkout' : 'GitHub'}</small></span>${icon('chevd', 's')}</a>
    <nav class="nav"><span class="lbl">Review</span>
      ${a(S.base, 'plans', 'layers', 'Plans', `<span class="count">${plans.length}</span>`)}
      ${a(`${S.base}/needs`, 'needs', 'inbox', 'Needs you', `<span class="count ${needs ? 'hot' : ''}">${needs}</span>`)}
      ${a(`${S.base}/activity`, 'activity', 'pulse', 'Activity', '')}</nav>
    <div class="rail-foot">
      ${isDemo ? `<div class="note"><svg class="waves" viewBox="0 0 120 50" aria-hidden="true"><g fill="none" stroke="#a7dbd3" stroke-width="2"><path d="M0 14c20-8 40 8 60 0s40-8 60 0"/><path d="M0 28c20-8 40 8 60 0s40-8 60 0"/><path d="M0 42c20-8 40 8 60 0s40-8 60 0"/></g></svg><b>Demo workspace</b>Fernwood is a made-up team. You're Noah, the tech lead. Approve, comment and resolve freely: nothing leaves this tab.<div style="margin-top:8px"><button class="linkbtn" data-act="demo-reset">${icon('refresh', 'xs')}Reset demo</button></div></div>` : ''}
      ${viewer() ? `<div class="me">${avatar(viewer(), 'lg')}<span><b>${esc(person(viewer()))}</b><small>${isDemo ? 'Tech lead · demo' : `@${esc(viewer())}`}</small></span></div>` : S.src?.mode === 'github' ? `<a class="btn sm" href="#/connect?repo=${encodeURIComponent(S.src.repo)}">${icon('gh', 's')}Connect GitHub to post</a>` : ''}
      <button class="keys" data-act="help">${icon('kbd', 's')}Keyboard shortcuts <kbd>?</kbd></button>
    </div>
  </aside>
  <div class="topbar"><a class="brand" href="${S.base}"><img src="logo-mark.svg" alt="" data-act="boat"><span>Lake<span class="dot">.</span></span></a>${isDemo ? '<span class="demo-flag">Demo</span>' : ''}<nav>
    <a href="${S.base}" ${cur === 'plans' ? 'aria-current="page"' : ''}>Plans</a><a href="${S.base}/needs" ${cur === 'needs' ? 'aria-current="page"' : ''}>Needs you${needs ? ` · ${needs}` : ''}</a><a href="${S.base}/activity" ${cur === 'activity' ? 'aria-current="page"' : ''}>Activity</a></nav></div>
  ${isDemo ? `<div class="mdemo">${icon('spark', 'xs')}<span>Demo · fictional team · nothing leaves this tab</span><button class="linkbtn" data-act="demo-reset">Reset</button></div>` : ''}`;
}

// ---------- dashboard ----------
const FILTERS = [['all', 'All'], ['needs', 'Needs you'], ['in-review', 'In review'], ['changes-requested', 'Changes requested'], ['approved', 'Approved'], ['draft', 'Draft']];
const isApproved = (p) => p.status === 'approved' || p.status === 'auto-approved';
function matchesFilter(p, f) { return f === 'all' ? true : f === 'needs' ? needsMe(p) : f === 'approved' ? isApproved(p) : p.status === f; }
function filtered() {
  const f = route.filter || (S.filter === 'needs' ? 'all' : S.filter);
  const q = S.q.trim().toLowerCase();
  const order = { 'in-review': 0, 'changes-requested': 1, draft: 2, approved: 3, 'auto-approved': 3 };
  return S.ws.plans.filter((p) => matchesFilter(p, f))
    .filter((p) => !q || `${p.title} ${p.id} ${p.author} ${person(p.author)}`.toLowerCase().includes(q))
    .sort((a, b) => (needsMe(b) - needsMe(a)) || (order[a.status] - order[b.status]) || String(b.lastActivity).localeCompare(String(a.lastActivity)));
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const roundDots = (p) => `<span class="rounds" title="${p.round} round${p.round > 1 ? 's' : ''}">${p.rounds.map((r) => `<i class="${r.current ? (isApproved(p) ? 'approved' : 'cur') : r.outcome}"></i>`).join('')}</span>`;
function reviewerStack(p) {
  const rs = p.reviewers.slice(0, 4);
  if (!rs.length) return '<span class="thr">No reviewers yet</span>';
  return `<span class="stack">${rs.map((r) => avatar(r.login, 'sm', r.current || r.verdict === 'waiting' || r.verdict === 'commented' ? VERDICT_BADGE[r.verdict] : 'wait')).join('')}</span>`;
}
function spotlight(top) {
  const r = top.rounds[top.rounds.length - 1]; const prev = top.rounds[top.rounds.length - 2];
  const askers = prev ? prev.verdicts.filter((v) => v.action === 'reject').map((v) => first(v.login)) : [];
  const appr = top.reviewers.find((x) => x.verdict === 'approved' && x.current);
  const need = top.policy.needed;
  return `<section class="spot" aria-label="Your next decision"><div class="copy">
    <span class="k">Your next decision</span><h2>${esc(top.title)}</h2>
    <p>${esc(first(top.author))} ${top.round > 1 ? `sent round ${top.round}${askers.length ? ` after ${askers.join(' and ')} asked for changes` : ''}` : 'asked for your review'}. ${need ? `It needs ${need} more approval${need > 1 ? 's' : ''}.` : ''}</p>
    <div class="row"><a class="btn primary" href="${planHref(top)}">Review round ${top.round} ${icon('arrow', 's')}</a>
      ${r.stats ? `<span class="sub" style="margin:0;font-size:13px"><span class="plus">+${r.stats.added}</span> <span class="minus">−${r.stats.removed}</span> lines since round ${top.round - 1}</span>` : ''}
      <span class="sub num" style="margin:0;font-size:13px">${range(costOf(top.estimate))} est.</span></div>
  </div><div class="scene">${scene('sp')}<div class="float">${avatar(appr?.login || top.author, 'lg', appr ? 'ok' : '')}<span><b>${appr ? `${esc(first(appr.login))} approved v${top.short}` : `Round ${top.round} is ready`}</b>Catch it in the plan, not in the PR.</span></div></div></section>`;
}
function dash() {
  const ps = S.ws.plans; const me = viewer();
  const list = filtered();
  const needs = ps.filter(needsMe);
  const back = ps.filter((p) => p.status === 'changes-requested').length;
  const f = route.filter || (S.filter === 'needs' ? 'all' : S.filter);
  if (S.sel >= list.length) S.sel = Math.max(0, list.length - 1);
  const inRev = ps.filter((p) => p.status === 'in-review');
  const cost = inRev.reduce((a, p) => [a[0] + costOf(p.estimate)[0], a[1] + costOf(p.estimate)[1]], [0, 0]);
  const openThreads = ps.reduce((a, p) => a + p.openThreads, 0);
  const count = (k) => ps.filter((p) => matchesFilter(p, k)).length;
  return `
  <div class="page-head"><div>
    <div class="eyebrow"><span class="ln"></span>${esc(S.src.repo)}${S.src.mode === 'demo' ? ' <span class="demo-flag">Demo · fictional team</span>' : ''}</div>
    <h1 class="title">${me ? `${greeting()}, ${esc(first(me))}` : 'Plans'}</h1>
    <p class="sub">${needs.length ? `${needs.length} plan${needs.length > 1 ? 's need' : ' needs'} your review` : 'Nothing is waiting on you'}${back ? ` · ${back} back with the author` : ''}.</p>
    ${S.ws.limited ? `<p class="fine">Read without a GitHub token: the 10 most recent open PRs. <a href="#/connect?repo=${encodeURIComponent(S.src.repo)}">Connect a token</a> to see all plans and to review.</p>` : ''}
  </div>${S.src.mode !== 'demo' ? `<button class="btn" data-act="refresh">${icon('refresh', 's')}Refresh</button>` : ''}</div>
  ${needs[0] && f !== 'needs' ? spotlight(needs[0]) : ''}
  <div class="stats stagger">
    <div class="stat"><span class="v num">${inRev.length}</span><span class="l"><i style="background:#d39a2c"></i>In review</span></div>
    <div class="stat"><span class="v num">${back}</span><span class="l"><i style="background:var(--bad)"></i>Changes requested</span></div>
    <div class="stat"><span class="v num">${openThreads}</span><span class="l">${icon('msg', 'xs')}Open threads</span></div>
    <div class="stat"><span class="v num">${cost[1] ? range(cost) : '—'}</span><span class="l">${icon('coin', 'xs')}Est. agent cost in review</span></div>
  </div>
  <div class="toolbar"><h3>${f === 'needs' ? 'Needs you' : 'Plans'}</h3>
    <div class="seg" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => `<button data-act="filter" data-f="${k}" aria-pressed="${f === k}">${l}<span class="n">${count(k)}</span></button>`).join('')}</div>
    <label class="search">${icon('search', 's')}<input id="q" placeholder="Search plans" value="${esc(S.q)}" aria-label="Search plans"><kbd>/</kbd></label>
  </div>
  <div class="list" role="list">
    <div class="list-head"><span>Plan</span><span>Reviewers</span><span>Est. cost</span><span>Threads</span><span>Updated</span><span></span></div>
    <div class="stagger">${list.length ? list.map((p, i) => `
    <a class="prow ${i === S.sel ? 'sel' : ''}" role="listitem" href="${planHref(p)}" data-i="${i}">
      <span class="t"><span class="ic st-${isApproved(p) ? 'approved' : p.status}">${icon(STATUS[p.status][1])}</span><span style="min-width:0">
        <span class="name">${esc(p.title)}</span>
        <span class="meta">${chip(p.status)}${needsMe(p) ? `<span class="needs">${icon('dot', 'xs')}Needs you</span>` : ''}<span>${esc(first(p.author))}</span><span class="sep"></span>${p.pr ? `<span>#${p.pr.number}</span><span class="sep"></span>` : p.local ? '<span>local</span><span class="sep"></span>' : ''}${roundDots(p)}<span>round ${p.round}</span></span>
      </span></span>
      <span class="rvw">${reviewerStack(p)}</span>
      <span class="cost num">${range(costOf(p.estimate))}</span>
      <span class="thr ${p.openThreads ? 'open' : ''}">${icon('msg', 's')}${p.openThreads}</span>
      <span class="when">${rel(p.lastActivity)}</span>
      <span class="chev">${icon('chev', 's')}</span>
    </a>`).join('') : `<div class="empty"><b>${f === 'needs' ? 'You are all caught up' : 'No plans here'}</b>${f === 'needs' ? 'Nothing is waiting on your review.' : ps.length ? 'Try another filter.' : 'Plans appear here when a PR adds a file under <code>.lake/plans/</code>.'}</div>`}</div>
  </div>
  <div class="foot"><span class="ok">${icon('lock', 's')}Approvals bind to an exact plan version. Any edit needs a fresh yes.</span><span>${S.src.mode === 'demo' ? 'Fictional data · nothing is sent anywhere' : S.src.mode === 'local' && !S.src.env ? 'Read from your checkout · nothing leaves this machine' : 'Read from GitHub · no Lake server'}</span></div>`;
}

// ---------- plan ----------
function findPlan() {
  const ps = S.ws.plans.filter((p) => p.id === route.id);
  return (route.pr && ps.find((p) => p.pr?.number === route.pr)) || ps.find((p) => p.pr?.state === 'open') || ps[0];
}
const plainT = (x) => String(x).replace(/[`*_]/g, '').replace(/\s*[([]\s*model\s*:[^)\]]*[)\]]/i, '').trim();
const stepFor = (p, text) => p.estimate.steps.find((s) => plainT(text).startsWith(plainT(s.title).slice(0, 60)));
function threadsForRound(p, n) {
  const r = p.rounds[n - 1];
  if (r.current) return p.threads.filter((t) => !t.outdated).map((t) => ({ ...t, pos: t.current }));
  return p.threads.filter((t) => t.version === r.digest).map((t) => ({ ...t, pos: t.anchor ? { start: t.anchor.start, end: t.anchor.end } : null }));
}
function threadCard(p, t, readOnly, viewN = p.round) {
  const expanded = S.focus === t.id || !t.resolved || S.openThreads.has(t.id);
  const from = t.n !== viewN ? `<span class="chip soft">from round ${t.n}</span>` : '';
  if (!expanded) {
    return `<div class="thread res" id="t-${esc(t.id)}"><button class="collapsed" data-act="toggle-thread" data-t="${esc(t.id)}">${icon('check', 's')}<span><b>${esc(first(t.resolvedBy || t.comments[0]?.login))}</b> resolved ${esc(first(t.comments[0]?.login))}'s comment · ${t.comments.length} message${t.comments.length > 1 ? 's' : ''}</span>${from}${icon('chevd', 's')}</button></div>`;
  }
  const where = t.suggestion ? `<b>${esc(first(t.suggestion.by))}</b> suggests a change` : `${t.anchor?.heading ? `${esc(t.anchor.heading)} · ` : ''}${t.pos ? `line ${t.pos.start}${t.pos.end > t.pos.start ? `–${t.pos.end}` : ''}` : 'Whole plan'}`;
  const ctl = readOnly ? '' : t.resolved ? `<button class="btn sm ghost" data-act="reopen" data-t="${esc(t.id)}">Reopen</button>` : t.source === 'github' ? '' : `<button class="btn sm" data-act="resolve" data-t="${esc(t.id)}">${icon('check', 's')}Resolve</button>`;
  return `<div class="thread ${t.resolved ? 'res' : ''}" id="t-${esc(t.id)}">
    <div class="th">${icon('msg', 's')}<span class="grow">${where}${t.resolved ? ` · resolved by ${esc(first(t.resolvedBy))}` : ''}</span>${from}${t.source === 'github' ? `<span class="via">${icon('gh', 'xs')}GitHub line comment</span>` : ''}${ctl}</div>
    ${t.anchor?.quote && t.n !== viewN ? `<div class="quote">${esc(t.anchor.quote.slice(0, 220))}</div>` : ''}
    ${t.suggestion ? suggestionBox(p, t, readOnly) : ''}
    ${t.comments.map((c) => `<div class="cmt">${avatar(c.login)}<div><div class="hd"><b>${esc(person(c.login))}</b><span>${rel(c.at)}</span></div><div class="txt">${inline(c.text)}</div></div></div>`).join('')}
    ${readOnly ? '<div style="height:12px"></div>' : `<div class="tf">${viewer() ? avatar(viewer(), 'sm') : ''}<input data-reply="${esc(t.id)}" placeholder="Reply…  Enter to send" aria-label="Reply"></div>`}
  </div>`;
}
function savingOf(p, sg) {
  if (sg.saving) return sg.saving[1];
  if (sg.patch?.type === 'planModel') { const o = p.modelOptions.find((x) => x.key === sg.patch.model || x.name === sg.patch.model); const cur = p.estimate.declared ? p.estimate.plannedUsd[1] : p.estimate.usd[1]; return o ? cur - o.usd[1] : 0; }
  return 0;
}
function suggestionBox(p, t, readOnly) {
  const sg = t.suggestion; const save = savingOf(p, sg);
  const can = !readOnly && viewer() === p.author && !sg.accepted && !t.resolved && p.pr?.state === 'open';
  return `<div class="sugg ${sg.accepted ? 'done' : ''}"><span class="ic">${icon(sg.accepted ? 'check' : 'spark', 's')}</span><div class="grow"><b>${esc(sg.title)}</b>
    <span>${sg.accepted ? `Accepted by ${esc(first(sg.acceptedBy))}${sg.newVersion ? ` · now v${esc(sg.newVersion)}` : ''}` : save > 0.005 ? `Saves up to <b class="num">${money(save)}</b>` : save < -0.005 ? `Costs up to ${money(-save)} more` : 'Same cost'}</span></div>
    ${can ? `<button class="btn sm primary" data-act="accept" data-t="${esc(t.id)}">${icon('check', 's')}Accept</button>` : ''}</div>`;
}
function composer(p) {
  const c = S.compose;
  return `<div class="composer" id="composer"><div class="lab">${icon('msg', 's')}<span>Comment on ${c.heading ? `<b>${esc(c.heading)}</b> · ` : ''}line ${c.s}${c.e > c.s ? `–${c.e}` : ''}${c.quote ? ` · “${esc(c.quote.slice(0, 60))}${c.quote.length > 60 ? '…' : ''}”` : ''}</span></div>
    <textarea id="ctext" placeholder="What should change, and why?" aria-label="Comment"></textarea>
    <div class="row"><span class="hint">Posted to ${p.pr ? `PR #${p.pr.number}` : 'the PR'}, anchored to v${p.short}</span><button class="btn sm ghost" data-act="compose-cancel">Cancel</button><button class="btn sm primary" data-act="compose-submit">Comment <span class="k">⌘↵</span></button></div></div>`;
}
function docView(p, n) {
  const r = p.rounds[n - 1]; const isCur = r.current;
  const blocks = parseBlocks(r.body);
  const threads = threadsForRound(p, n);
  const placed = new Set();
  const forRange = (s, e) => threads.filter((t) => t.pos && !placed.has(t.id) && t.pos.start >= s && t.pos.start <= e).map((t) => { placed.add(t.id); return t; });
  const canComment = isCur && S.src.canWrite && !!p.pr && p.pr.state === 'open';
  const ro = !isCur || !S.src.canWrite;
  const inC = (s, e) => S.compose && isCur && S.compose.s >= s && S.compose.s <= e;
  const addBtn = (s, e) => (canComment ? `<button class="add" data-act="add" data-s="${s}" data-e="${e}" aria-label="Comment on line ${s}">${icon('plus')}</button>` : '');
  const thr = (ts, s, e, indent) => (ts.length || inC(s, e) ? `<div class="threads" style="margin-left:${indent}px">${ts.map((t) => threadCard(p, t, ro, n)).join('')}${inC(s, e) ? composer(p) : ''}</div>` : '');
  const out = [];
  for (const b of blocks) {
    if (b.type === 'list') {
      for (const it of b.items) {
        const ts = forRange(it.start, it.end);
        const st = isCur ? stepFor(p, it.text) : null;
        const foc = ts.some((t) => t.id === S.focus) || inC(it.start, it.end);
        out.push(`<div class="li ${ts.length ? 'has' : ''} ${foc ? 'focus' : ''}" data-s="${it.start}" data-e="${it.end}"><span class="gut">${addBtn(it.start, it.end)}</span>
          <span class="mk ${b.ordered ? '' : 'b'}">${b.ordered ? `${it.num}.` : ''}</span>
          <div class="tx">${inline(it.text)}${st ? `<span class="cost"><span class="mchip ${st.complexity} ${st.fit || ''}" title="${esc(st.complexity)} complexity: ${esc(st.reasons.join(', '))}${st.planned && st.fit !== 'ok' ? ` · Lake pick: ${esc(st.model)}` : ''}">${st.fit === 'risky' ? '! ' : ''}${esc(short(st.planned ? st.planned.name : st.model))}</span><span class="num" style="font-size:12px;color:var(--muted)">${range(st.planned ? st.planned.usd : st.usd)}</span></span>` : ''}${it.sub.length ? `<ul>${it.sub.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}</div></div>`);
        out.push(thr(ts, it.start, it.end, 60));
      }
      continue;
    }
    const ts = forRange(b.start, b.end);
    const lv = Math.min(4, b.level || 2);
    const raw = String(r.body).split('\n').slice(b.start - 1, b.end).join(' ');
    const decl = b.type !== 'heading' && raw.match(/^\s*(?:\*\*)?(model|budget cap)(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i);
    const tag = b.type === 'heading' ? `<h${lv}>${b.html}</h${lv}>` : decl ? `<p class="declare">${icon(/model/i.test(decl[1]) ? 'cpu' : 'coin', 's')}<span>${/model/i.test(decl[1]) ? (overridden(r.estimate) ? 'Default model' : 'Runs on') : 'Budget cap'}</span><b>${esc(/model/i.test(decl[1]) && r.estimate.model ? r.estimate.model.name : decl[2].replace(/\*/g, ''))}</b>${/model/i.test(decl[1]) && overridden(r.estimate) ? `<span>· ${overridden(r.estimate)} step${overridden(r.estimate) > 1 ? 's' : ''} overridden</span>` : ''}</p>` : b.html;
    const foc = ts.some((t) => t.id === S.focus) || inC(b.start, b.end);
    out.push(`<div class="blk ${ts.length ? 'has' : ''} ${foc ? 'focus' : ''}" data-s="${b.start}" data-e="${b.end}"><span class="gut"><span class="ln">${b.start}</span>${b.type !== 'hr' ? addBtn(b.start, b.end) : ''}</span><div class="body">${tag}</div></div>`);
    out.push(thr(ts, b.start, b.end, 34));
  }
  const general = threads.filter((t) => !t.pos);
  return `<article class="doc" id="doc" aria-label="Plan text">
    <div class="doc-top">${icon('file', 's')}<span class="mono path">${esc(p.path)}</span><span class="grow"></span><span class="chip line mono">v${r.short}</span>${canComment ? '<span>Select text or hover a line to comment</span>' : !isCur ? '<span>Earlier round · read-only</span>' : ''}</div>
    ${general.length ? `<div class="threads" style="margin:0 0 12px 34px">${general.map((t) => threadCard(p, t, ro, n)).join('')}</div>` : ''}
    ${out.join('')}
  </article>`;
}
function reviewCard(p) {
  const ok = p.policy.approvers.length; const total = Math.max(ok + p.policy.needed, ok, 1);
  const rows = p.reviewers.map((r) => {
    const stale = r.verdict !== 'waiting' && r.verdict !== 'commented' && !r.current;
    const label = r.verdict === 'approved' ? (r.current ? `Approved v${r.short}` : `Approved round ${r.n}, not this version`)
      : r.verdict === 'changes-requested' ? (r.current ? `Requested changes on v${r.short}` : `Asked for changes in round ${r.n} · hasn't seen round ${p.round}`)
        : r.verdict === 'waiting' ? 'Review requested' : r.verdict === 'revoked' ? 'Withdrew approval' : 'Commented';
    return `<div class="rv">${avatar(r.login, '', stale ? 'wait' : VERDICT_BADGE[r.verdict])}<div><div class="n">${esc(person(r.login))}${r.login === viewer() ? ' <span class="chip soft" style="height:18px;font-size:11px">you</span>' : ''}${r.budget ? ` <span class="chip soft budget-tag" style="height:18px;font-size:11px">${icon('coin', 'xs')}budget</span>` : ''}</div><div class="d">${label}${r.via && r.current ? ` · <span class="via">${viaIcon(r.via)}${esc(r.via)}</span>` : ''}</div></div><span class="d">${rel(r.at)}</span>${r.text && r.current ? `<div class="note2">${inline(r.text)}</div>` : ''}</div>`;
  }).join('');
  return `<section class="card" aria-label="Review"><h4>${icon('check', 's')}Review<span class="r">${ok} of ${total} approval${total > 1 ? 's' : ''}</span></h4>
    <div class="meter" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<span style="width:${100 / total}%;background:${i < ok ? 'var(--ok)' : 'transparent'};border-right:2px solid #fff"></span>`).join('')}</div>
    ${rows || '<p style="font-size:12.5px;color:var(--muted)">No reviewers yet. Anyone with write access except the author can approve.</p>'}
    ${p.policy.auto?.mode === 'shadow' && p.policy.auto.eligible ? '<p class="fine">Small and cheap: the auto-approve policy (shadow mode) would pass this plan. A human still decides.</p>' : ''}
  </section>`;
}
function costCard(p, n) {
  const r = p.rounds[n - 1]; const est = r.estimate; const isCur = r.current;
  const planned = est.declared ? est.plannedUsd : est.usd;
  const author = !!viewer() && viewer() === p.author;
  const canAct = isCur && S.src.canWrite && !!p.pr && p.pr.state === 'open';
  const max = Math.max(...est.steps.map((s) => (s.planned ? s.planned.usd[1] : s.usd[1])), 0.0001);
  const b = isCur ? p.budget : null;
  const budget = b?.required ? `<div class="budget ${b.satisfied ? 'ok' : ''}">${icon(b.satisfied ? 'check' : 'lock', 's')}<span>${b.satisfied ? `Budget OK from <b>${esc(first(b.approvedBy[0]))}</b> for v${p.short}` : `Over the team's ${money(b.threshold)} line. <b>${b.approvers.map((a) => esc(first(a))).join(' or ')}</b> signs off too.`}</span></div>` : '';
  const sugg = isCur ? p.suggestions.slice(0, 3) : [];
  const act = (attrs, label, primary) => (canAct ? `<button class="btn sm ${primary ? 'primary' : ''}" ${attrs}>${label}</button>` : '');
  const best = sugg.length ? Math.max(...sugg.map((x) => x.saving[1])) : 0;
  const saveHtml = sugg.length ? `<div class="save"><div class="save-h">${icon('spark', 's')}<span>Lake can trim up to <b class="num">${money(best)}</b></span></div>${sugg.map((x) => `<div class="sg"><div class="grow"><b>${esc(x.title)}</b><span class="num">−${money(x.saving[1])}</span></div>${act(`data-act="${author ? 'apply' : 'suggest'}" data-sid="${esc(x.id)}"`, author ? 'Apply' : 'Suggest', author)}</div>`).join('')}</div>` : '';
  const curKey = est.model ? est.model.key : est.declared ? null : 'lake-mix';
  const opts = isCur && p.modelOptions ? `<details class="models"${S.modelsOpen ? ' open' : ''}><summary data-act="models-toggle">${icon('cpu', 's')}Compare models${icon('chevd', 'xs')}</summary>${p.modelOptions.map((o) => `<div class="mo ${o.fit} ${o.key === curKey ? 'cur' : ''}"><div class="grow"><span class="nm">${esc(short(o.name))}${o.recommended ? '<i>Lake pick</i>' : ''}${o.key === curKey ? '<i class="c">in plan</i>' : ''}</span><span class="nt">${esc(o.note)}</span></div><span class="num pr">${range(o.usd)}</span>${o.key !== curKey && o.key !== 'lake-mix' ? act(`data-act="${author ? 'use-model' : 'suggest-model'}" data-m="${esc(o.key)}"`, author ? 'Use' : 'Suggest') : ''}</div>`).join('')}</details>` : '';
  return `<section class="card cost" aria-label="Model and cost"><h4>${icon('coin', 's')}Model &amp; cost<span class="r">${esc(est.complexity)} complexity</span></h4>
    <div class="est-total num">${range(planned)}</div><div class="est-sub">${overridden(est) ? `planned per step${est.model ? ` (default <b>${esc(short(est.model.name))}</b>)` : ''}` : est.model ? `on <b>${esc(short(est.model.name))}</b>` : est.declared ? 'models set per step' : 'Lake pick per step · no model set in the plan'}${est.cap != null ? ` · capped at ${money(est.cap)}` : ''}</div>
    ${budget}
    ${est.steps.map((s) => { const u = s.planned ? s.planned.usd : s.usd; const m = s.planned ? s.planned.name : s.model; return `<div class="step"><span class="sn">${s.n}</span><span class="st" title="${esc(s.title)}">${esc(s.title)}</span><span class="mchip ${s.complexity} ${s.fit}" title="${s.fit === 'risky' ? 'May be too weak for this step' : s.fit === 'overkill' ? `More than this step needs. Lake pick: ${esc(s.model)}` : esc(s.complexity) + ' complexity'}">${s.fit === 'risky' ? '! ' : ''}${esc(short(m))}</span><span class="bar"><i class="${s.complexity}" style="width:${Math.max(6, (u[1] / max) * 100)}%"></i></span></div>`; }).join('')}
    ${saveHtml}${opts}
    ${(est.modelNotes || []).map((x) => `<p class="fine" style="color:var(--warn)">${esc(x)}</p>`).join('')}
    <p class="fine">Forecast from the plan text and list prices (${esc(est.pricesAsOf)}). Not a quote.</p></section>`;
}
function threadsCard(p) {
  const tf = S.tfilter;
  const open = p.threads.filter((t) => !t.resolved && !t.outdated); const res = p.threads.filter((t) => t.resolved); const out = p.threads.filter((t) => t.outdated && !t.resolved);
  const list = tf === 'open' ? open : tf === 'resolved' ? res : out;
  return `<section class="card" aria-label="Threads"><h4>${icon('msg', 's')}Threads<span class="r">${open.length} open</span></h4>
    <div class="tabs-mini" role="group" aria-label="Thread filter"><button data-act="tfilter" data-f="open" aria-pressed="${tf === 'open'}">Open ${open.length}</button><button data-act="tfilter" data-f="resolved" aria-pressed="${tf === 'resolved'}">Resolved ${res.length}</button>${out.length ? `<button data-act="tfilter" data-f="outdated" aria-pressed="${tf === 'outdated'}">Outdated ${out.length}</button>` : ''}</div>
    <div class="tlist">${list.length ? list.map((t) => `<button class="tl ${t.resolved ? 'res' : ''}" data-act="goto-thread" data-t="${esc(t.id)}">${avatar(t.comments[0]?.login, 'sm')}<span style="min-width:0"><span class="q" style="display:block">${esc(t.comments[0]?.text || '')}</span><span class="m">${esc(first(t.comments[0]?.login))} · round ${t.n}${t.anchor?.heading ? ` · ${esc(t.anchor.heading)}` : ''} · ${t.comments.length} msg${t.outdated ? ' · text changed' : ''}</span></span></button>`).join('') : `<p style="font-size:12.5px;color:var(--muted);padding:4px 8px">${tf === 'open' ? 'No open threads.' : 'None.'}</p>`}</div></section>`;
}
function howCard(p) {
  return `<section class="card" aria-label="Where reviews live"><h4>${icon('lock', 's')}One source of truth</h4><div class="how">
    <div>${icon('check', 's')}<span>Every verdict, comment and resolve here is a comment on ${p.pr ? `<a class="linkbtn" href="${esc(p.pr.url)}" target="_blank" rel="noopener">PR #${p.pr.number}</a>` : 'the PR'}.</span></div>
    <div>${icon('gh', 's')}<span>GitHub's own <b>Review changes → Approve</b> counts too, for the plan version at that commit.</span></div>
    <div>${icon('bot', 's')}<span>Claude Code and Cursor see the same threads through the lake-gate MCP server, and can approve when you tell them to.</span></div></div></section>`;
}
function banner(p, n) {
  const r = p.rounds[n - 1];
  if (!r.current) {
    return `<div class="banner old"><span class="ico" style="background:#fbefd2;color:#8a5d10">${icon('layers')}</span><span>You're reading <b>round ${n}</b> (v${r.short}). It ended with <b>${(STATUS[r.outcome]?.[0] || r.outcome).toLowerCase()}</b>. Comments here are read-only.</span><span class="who-row"><a class="btn sm" href="${planHref(p, `/diff/${n}/${p.round}`)}">Compare with current</a><a class="btn sm primary" href="${planHref(p)}">Go to round ${p.round}</a></span></div>`;
  }
  const st = p.status; const names = (xs) => xs.map((a) => esc(first(a))).join(' and ');
  const msg = st === 'approved' ? `<b>Approved</b> by ${names(p.policy.approvers)} for v${p.short}. The agent can build this exact version.`
    : st === 'auto-approved' ? '<b>Auto-approved</b> by the team policy (small and cheap).'
      : st === 'changes-requested' ? `<b>Changes requested</b> by ${names(p.policy.blockers)}. The agent waits for a new round.`
        : st === 'needs-budget' ? `<b>Reviewers approved.</b> Up to ${money(p.budget.exposure)} is over the team's ${money(p.budget.threshold)} line, so ${p.budget.approvers.map((a) => esc(first(a))).join(' or ')} signs off too.`
        : st === 'draft' ? `<b>Draft.</b> ${p.local ? `Only in your checkout${p.local.unpushed ? ', edited since the PR version' : ''}. Push it and open a PR to ask for review.` : 'Mark the PR ready for review when the plan is.'}`
          : `<b>Waiting for ${p.policy.needed} more approval${p.policy.needed > 1 ? 's' : ''}.</b> ${p.policy.approvers.length ? `${names(p.policy.approvers)} approved this version.` : 'No approvals on this version yet.'}`;
  return `<div class="banner st-${st}"><span class="ico">${icon(STATUS[st][1])}</span><span>${msg}</span><span class="who-row">${p.openThreads ? `${icon('msg', 's')}${p.openThreads} open thread${p.openThreads > 1 ? 's' : ''}` : `${icon('check', 's')}No open threads`}</span></div>`;
}
function actionsHtml(p, mobile) {
  if (!p.pr) return '';
  const me = viewer();
  if (!S.src.canWrite) return mobile ? '' : `<a class="btn" href="${esc(p.pr.url)}" target="_blank" rel="noopener">${icon('gh', 's')}Open PR</a>${S.src.mode === 'github' ? `<a class="btn primary" href="#/connect?repo=${encodeURIComponent(S.src.repo)}">Connect GitHub to review</a>` : ''}`;
  if (me === p.author) return mobile ? '' : `<span class="youdid" style="background:#e9f1ef;color:var(--ink2)">${icon('file', 's')}You wrote this plan</span>`;
  if (p.pr.state !== 'open') return mobile ? '' : `<span class="youdid">${icon('check', 's')}PR ${esc(p.pr.state)}</span>`;
  if (myVerdict(p) === 'approved') return `<span class="youdid">${icon('check', 's')}You approved v${p.short}</span>`;
  return `<button class="btn ${mobile ? '' : 'danger'}" data-act="changes">${icon('undo', 's')}Request changes${mobile ? '' : ' <span class="k">R</span>'}</button><button class="btn primary" data-act="approve">${icon(p.budget?.required && p.budget.approvers.includes(me) ? 'coin' : 'check', 's')}${p.budget?.required && p.budget.approvers.includes(me) && !p.budget.satisfied ? 'Approve with budget' : 'Approve'}${mobile ? '' : ` v${p.short} <span class="k">A</span>`}</button>`;
}
function planView() {
  const p = findPlan();
  if (!p) return `<div class="empty"><b>Plan not found</b><a class="linkbtn" href="${S.base}">Back to plans</a></div>`;
  const n = Math.min(p.round, Math.max(1, Number(route.q.round) || p.round));
  const tab = route.tab;
  const ol = outline(parseBlocks(p.rounds[n - 1].body));
  const ths = threadsForRound(p, n);
  const cur = (t) => (tab === t ? 'aria-current="page"' : '');
  const tabs = `<nav class="tabs" aria-label="Plan views">
    <a href="${planHref(p)}" ${cur('plan')}>${icon('file', 's')}Plan</a>
    <a href="${planHref(p, '/rounds')}" ${cur('rounds')}>${icon('layers', 's')}Rounds<span class="n">${p.round}</span></a>
    ${p.round > 1 ? `<a href="${planHref(p, '/diff')}" ${cur('diff')}>${icon('diff', 's')}Changes</a>` : ''}
    <a href="${planHref(p, '/activity')}" ${cur('activity')}>${icon('pulse', 's')}Activity<span class="n">${p.timeline.length}</span></a>
    ${tab === 'plan' && p.round > 1 ? `<div class="roundbar" role="group" aria-label="Rounds">${p.rounds.map((r, i) => `${i ? '<span class="rconn"></span>' : ''}<button class="rpill" data-act="round" data-n="${r.n}" aria-pressed="${r.n === n}" title="${esc(STATUS[r.outcome]?.[0] || r.outcome)}"><i class="${r.outcome}"></i>Round ${r.n}${r.current ? ' · current' : ''}</button>`).join('')}</div>` : ''}
  </nav>`;
  let body;
  if (tab === 'plan') {
    const sections = ol.map((o) => { const c = ths.filter((t) => t.pos && t.pos.start >= o.start && t.pos.start <= o.end && !t.resolved).length; return `<a href="#" data-act="jump" data-s="${o.start}" class="${o.level === 3 ? 'l3' : ''}">${esc(o.title)}${c ? `<span class="c">${icon('msg', 'xs')}${c}</span>` : ''}</a>`; }).join('');
    body = `<div class="grid3">
      <nav class="outline" aria-label="Sections"><span class="h">Sections</span>${sections}
        <div class="meta"><span>${icon('pr', 'xs')} ${p.pr ? `<a class="linkbtn" href="${esc(p.pr.url)}" target="_blank" rel="noopener">#${p.pr.number}</a> ${esc(p.pr.branch || '')}` : 'Not on a PR'}</span><span>Version <span class="mono">${p.rounds[n - 1].short}</span></span><span>Or comment: <code style="font-size:10.5px">${esc(p.approveLine)}</code></span></div></nav>
      ${docView(p, n)}
      <aside class="side">${reviewCard(p)}${costCard(p, n)}${threadsCard(p)}${howCard(p)}</aside></div>`;
  } else if (tab === 'rounds') body = roundsView(p);
  else if (tab === 'diff') body = diffView(p);
  else body = `<div class="feed">${feed(p.timeline)}</div>`;
  return `
  <div class="crumbs"><a href="${S.base}">Plans</a>${icon('chev')}<span class="mono">${esc(p.id)}</span></div>
  <header class="phead"><div><h1>${esc(p.title)}</h1>
    <div class="meta">${chip(p.status)}<span class="who">${avatar(p.author, 'sm')}${esc(person(p.author))}</span>${p.pr ? `<a href="${esc(p.pr.url)}" target="_blank" rel="noopener">${icon('pr', 's')} #${p.pr.number}</a>` : ''}<span>Round ${p.round}</span><span>Updated ${rel(p.lastActivity)}</span>${S.src.mode === 'demo' ? '<span class="demo-flag">Demo</span>' : ''}</div></div>
    <div class="acts">${actionsHtml(p)}</div></header>
  ${banner(p, tab === 'plan' ? n : p.round)}
  ${tabs}
  ${tab === 'plan' && p.round > 1 ? `<div class="mrounds" role="group" aria-label="Rounds">${p.rounds.map((r) => `<button class="rpill" data-act="round" data-n="${r.n}" aria-pressed="${r.n === n}"><i class="${r.outcome}"></i>Round ${r.n}${r.current ? ' · current' : ''}</button>`).join('')}</div>` : ''}
  ${body}
  <div class="mbar">${actionsHtml(p, true)}</div>`;
}
function verdictLine(v) {
  const what = v.action === 'approve' ? 'approved' : v.action === 'reject' ? 'requested changes' : 'withdrew approval';
  return `<div class="vd">${avatar(v.login, '', v.action === 'approve' ? 'ok' : v.action === 'reject' ? 'bad' : '')}<div><div class="hd"><b>${esc(person(v.login))}</b><span>${what}</span><span class="via">${viaIcon(v.via)}${esc(v.via)}</span>${v.self ? '<span class="chip soft">author, does not count</span>' : ''}<span style="color:var(--muted)">${rel(v.at)}</span></div>${v.text ? `<div class="txt">${inline(v.text)}</div>` : ''}</div></div>`;
}
function roundsView(p) {
  const cards = p.rounds.map((r) => {
    const delta = r.n > 1 ? costOf(r.estimate)[1] - costOf(p.rounds[r.n - 2].estimate)[1] : 0;
    const th = r.threads; const resolved = th.filter((t) => t.resolved).length;
    return `<div class="rcard"><div class="rnum ${r.current ? (isApproved(p) ? 'approved' : 'cur') : r.outcome}">${r.n}</div><div class="rbody">
      <div class="top"><b>Round ${r.n}</b><span class="chip line mono">v${r.short}</span>${chip(r.current ? p.status : r.outcome)}<span class="grow"></span>
        <a class="btn sm" href="${planHref(p)}${r.current ? '' : `?round=${r.n}`}">Read</a>${r.n > 1 ? `<a class="btn sm" href="${planHref(p, `/diff/${r.n - 1}/${r.n}`)}">${icon('diff', 's')}Changes</a>` : ''}</div>
      <div class="rmeta"><span class="who">${avatar(r.author || p.author, 'sm')}${esc(first(r.author || p.author))} ${r.n === 1 ? 'opened the plan' : 'revised it'}</span><span>${rel(r.at)}</span>
        ${r.stats ? `<span><span class="plus">+${r.stats.added}</span> <span class="minus">−${r.stats.removed}</span> lines</span>` : ''}
        <span class="num">${range(costOf(r.estimate))}${r.estimate.model ? ` · ${esc(short(r.estimate.model.name))}${overridden(r.estimate) ? ' + per step' : ''}` : ''}${Math.abs(delta) > 0.005 ? ` <span class="${delta > 0 ? 'minus' : 'plus'}">(${delta > 0 ? '+' : '−'}${money(Math.abs(delta))})</span>` : ''}</span>
        <span>${th.length} thread${th.length === 1 ? '' : 's'}${th.length ? `, ${resolved} resolved` : ''}</span></div>
      ${r.verdicts.map(verdictLine).join('')}
      ${!r.verdicts.length ? `<div class="rmeta" style="margin-top:10px">${r.current ? 'No verdicts on this round yet.' : 'Superseded before anyone gave a verdict.'}</div>` : ''}
    </div></div>`;
  }).join('');
  return `<div class="rgrid"><div class="rtl">${cards}</div><aside class="side">${reviewCard(p)}${costCard(p, p.round)}</aside></div>`;
}
function diffView(p) {
  if (p.round < 2) return '<div class="empty"><b>Only one round so far</b>Changes appear after the first revision.</div>';
  const b = Math.min(p.round, route.b || p.round); const a = Math.max(1, Math.min(b - 1, route.a || b - 1));
  const A = p.rounds[a - 1]; const B = p.rounds[b - 1];
  const d = lineDiff(A.body, B.body); const st = diffStats(d);
  const rows = [];
  for (let i = 0; i < d.length;) {
    if (d[i].op === 'same') { rows.push(d[i]); i++; continue; }
    const dels = []; const adds = [];
    while (i < d.length && d[i].op === 'del') dels.push(d[i++]);
    while (i < d.length && d[i].op === 'add') adds.push(d[i++]);
    if (dels.length && dels.length === adds.length) dels.forEach((x, k) => { const w = wordDiff(x.text, adds[k].text); rows.push({ ...x, w }); rows.push({ ...adds[k], w }); });
    else rows.push(...dels, ...adds);
  }
  // keep pairs grouped: dels then adds already interleaved per pair; show changed lines with 2 lines of context
  const keep = rows.map((r, i) => r.op !== 'same' || S.expand || rows.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== 'same'));
  const html = []; let gap = 0;
  const gapRow = (g) => `<button class="dl gap" data-act="expand" style="width:100%;text-align:left"><span></span><span></span><span></span><span class="c">⋯ ${g} unchanged line${g > 1 ? 's' : ''}</span></button>`;
  rows.forEach((r, i) => {
    if (!keep[i]) { gap++; return; }
    if (gap) { html.push(gapRow(gap)); gap = 0; }
    const own = r.op === 'add' ? 'add' : 'del';
    const w = r.w ? r.w.filter((x) => x.op === 'same' || x.op === own).map((x) => (x.op === 'same' ? esc(x.text) : own === 'add' ? `<ins>${esc(x.text)}</ins>` : `<del>${esc(x.text)}</del>`)).join('') : esc(r.text);
    html.push(`<div class="dl ${r.op}"><span class="n">${r.a || ''}</span><span class="n">${r.b || ''}</span><span class="s">${r.op === 'add' ? '+' : r.op === 'del' ? '−' : ''}</span><span class="c">${w || ' '}</span></div>`);
  });
  if (gap) html.push(gapRow(gap));
  const sel = (name, v) => `<select data-act="diffsel" data-which="${name}" aria-label="${name === 'a' ? 'From round' : 'To round'}">${p.rounds.map((r) => `<option value="${r.n}" ${r.n === v ? 'selected' : ''}>Round ${r.n} · v${r.short}</option>`).join('')}</select>`;
  const delta = costOf(B.estimate)[1] - costOf(A.estimate)[1];
  const asks = A.verdicts.filter((v) => v.action === 'reject').map(verdictLine).join('');
  const athreads = A.threads.map((t) => `<div class="tl ${t.resolved ? 'res' : ''}">${avatar(t.comments[0]?.login, 'sm')}<span style="min-width:0"><span class="q" style="display:block">${esc(t.comments[0]?.text || '')}</span><span class="m">${t.resolved ? `Resolved by ${esc(first(t.resolvedBy))}` : 'Still open'}${t.outdated ? ' · text changed' : ''}</span></span></div>`).join('');
  return `<div class="rgrid"><section class="diff" aria-label="Changes"><div class="diff-head"><b>Changes</b>${sel('a', a)}${icon('arrow', 's')}${sel('b', b)}<span style="flex:1"></span><span class="plus">+${st.added}</span><span class="minus">−${st.removed}</span><button class="btn sm ghost" data-act="expand">${S.expand ? 'Collapse' : 'Show all'}</button></div>${html.join('')}</section>
    <aside class="side"><section class="card"><h4>${icon('undo', 's')}What round ${a} asked for</h4>${asks || '<p class="fine" style="margin:0">No change requests in that round.</p>'}
      ${athreads ? `<div style="margin-top:12px" class="tlist">${athreads}</div>` : ''}</section>
      <section class="card"><h4>${icon('coin', 's')}Cost change</h4><div class="cdelta"><span class="num">${range(costOf(A.estimate))}</span>${icon('arrow', 's')}<b class="num">${range(costOf(B.estimate))}</b></div><p class="fine">${delta > 0.005 ? `Upper estimate up ${money(delta)}.` : delta < -0.005 ? `Upper estimate down ${money(-delta)}.` : 'About the same.'} ${B.estimate.steps.length} steps, ${esc(B.estimate.complexity)} complexity${B.estimate.model ? `, on ${esc(short(B.estimate.model.name))}` : ''}.</p></section></aside></div>`;
}
const FEED_ICON = { version: 'layers', comment: 'msg', reply: 'msg', resolve: 'check', reopen: 'undo', approve: 'check', reject: 'undo', revoke: 'x', accept: 'spark' };
function feedText(t, all) {
  const w = `<b>${esc(person(t.login))}</b>`;
  const on = all && t.plan ? ` · <a class="linkbtn" href="${planHref(t.plan)}">${esc(t.plan.title)}</a>` : '';
  const via = t.via ? ` <span class="via">${viaIcon(t.via)}${esc(t.via)}</span>` : '';
  switch (t.kind) {
    case 'version': return `${w} ${t.n === 1 ? 'opened the plan' : `sent round ${t.n}`} <span class="chip line mono">v${t.short}</span>${on}`;
    case 'comment': return `${w} commented${t.where ? ` on <b>${esc(t.where)}</b>` : ''}${on}`;
    case 'reply': return `${w} replied${on}`;
    case 'resolve': return `${w} resolved a thread${on}`;
    case 'reopen': return `${w} reopened a thread${on}`;
    case 'approve': return `${w} approved round ${t.n || '?'}${via}${t.self ? ' <span class="chip soft">author, does not count</span>' : ''}${on}`;
    case 'reject': return `${w} requested changes on round ${t.n || '?'}${via}${on}`;
    case 'revoke': return `${w} withdrew approval${on}`;
    case 'accept': return `${w} accepted a suggestion${t.short ? ` → <span class="chip line mono">v${esc(t.short)}</span>` : ''}${on}`;
    default: return `${w} ${esc(t.kind)}${on}`;
  }
}
function feed(items, all) {
  const groups = new Map();
  for (const t of [...items].reverse()) {
    if (!t.at) continue;
    const k = new Date(t.at).toDateString();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const label = (k) => { const d = new Date(k); return d.toDateString() === new Date().toDateString() ? 'Today' : d.toDateString() === new Date(Date.now() - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); };
  if (!groups.size) return '<div class="empty"><b>No activity yet</b></div>';
  return [...groups].map(([k, list]) => `<div class="day">${label(k)}</div>${list.map((t) => `<div class="ev"><span class="dotc ${t.kind}">${t.kind === 'comment' || t.kind === 'reply' ? avatar(t.login, 'sm') : icon(FEED_ICON[t.kind] || 'dot', 's')}</span><div><div class="line1">${feedText(t, all)}</div>${t.text && ['comment', 'reply', 'approve', 'reject', 'accept'].includes(t.kind) ? `<div class="txt">${inline(t.text)}</div>` : ''}</div><span class="tm">${new Date(t.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')}`).join('');
}
function teamActivity() {
  const items = S.ws.plans.flatMap((p) => p.timeline.map((t) => ({ ...t, plan: p })));
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return `<div class="page-head"><div><div class="eyebrow"><span class="ln"></span>${esc(S.src.repo)}</div><h1 class="title">Activity</h1><p class="sub">Who did what, across every plan.</p></div></div><div class="feed">${feed(items.slice(-80), true)}</div>`;
}

// ---------- connect ----------
function connectView() {
  const q = route.q; const has = !!tokenStore.get();
  return `<div class="topbar" style="display:flex"><a class="brand" href="#/connect"><img src="logo-mark.svg" alt=""><span>Lake<span class="dot">.</span></span></a></div>
  <main style="max-width:none;padding-top:0"><div class="connect">
    <section class="card"><div class="eyebrow"><span class="ln"></span>lake-gate review</div><h1>Review agent plans where your team already works.</h1>
      <p class="sub" style="font-size:14.5px">Plans, inline comments, review rounds and one-click approval, read from and written to your GitHub pull requests. No Lake server, no account.</p>
      <form id="connect">
        <div class="field"><label for="repo">Repository</label><input id="repo" name="repo" placeholder="owner/repo" value="${esc(q.repo || '')}" autocomplete="off" required></div>
        <div class="field"><label for="tok">GitHub token <span style="font-weight:400;color:var(--muted)">(to post, and for private repos)</span></label><input id="tok" name="tok" type="password" placeholder="${has ? 'Saved in this browser' : 'github_pat_…'}" autocomplete="off">
          <small>Fine-grained token for that repo with Pull requests read and write, Contents read. Kept only in this browser and sent only to api.github.com. <a class="linkbtn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create one ${icon('ext', 'xs')}</a></small></div>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px;font-size:13px"><input type="checkbox" name="remember" style="width:auto;height:auto"> Remember on this device</label>
        ${q.err ? `<p class="err">${esc(q.err)}</p>` : ''}
        <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap"><a class="btn primary" href="#/demo">Try the live demo ${icon('arrow', 's')}</a><button class="btn" type="submit">${icon('gh', 's')}Open repository</button>${has ? '<button class="btn ghost" type="button" data-act="signout">Forget token</button>' : ''}</div>
      </form>
      <p class="fine" style="margin-top:18px">Prefer local? Run <code>npx lake-gate ui</code> in your repo. It uses your existing <code>gh</code> login and also shows plans you haven't pushed yet.</p>
    </section>
    <section class="scene-card">${scene('cn', 'xMaxYMax')}<div class="cap"><b style="display:block;margin-bottom:4px">Catch it in the plan, not in the PR.</b>Comment on a line, send it back, compare rounds, approve the exact version. The agent waits for a real yes.</div></section>
  </div></main>`;
}

// ---------- sheet ----------
function sheetHtml() {
  const sh = S.sheet; const p = findPlanById(sh.key);
  if (!p) return '';
  const appr = sh.kind === 'approve';
  if (sh.state === 'done') {
    const after = appr ? (isApproved(p) ? 'That was the last approval needed. The agent can build this exact version.' : `It needs ${p.policy.needed} more approval${p.policy.needed > 1 ? 's' : ''}.`) : `${esc(first(p.author))} sees your note on ${esc(sh.posted?.where || 'the PR')} and in their agent.`;
    return `<div class="scrim" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-label="Done"><button class="x" data-act="close" aria-label="Close">${icon('x')}</button>
      <div class="done"><div class="ripple"><span></span><span></span><span></span><div class="stone ${appr ? '' : 'bad'}">${icon(appr ? 'check' : 'undo')}</div></div>
      <h3>${appr ? `You approved v${p.short}` : 'Sent back to the author'}</h3><p class="lead" style="margin:0">${after}</p>
      ${sh.posted ? `<details class="posted"><summary>What was posted to ${esc(sh.posted.where)}</summary><pre>${esc(sh.posted.body)}</pre></details>` : ''}
      <button class="btn primary" style="margin-top:12px" data-act="close" id="done-btn">Done</button></div></div></div>`;
  }
  const stale = sh.v && !p.digest.startsWith(sh.v);
  const open = p.threads.filter((t) => !t.resolved && !t.outdated);
  const mine = open.filter((t) => t.comments[0]?.login === viewer() && t.source !== 'github');
  return `<div class="scrim" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t"><button class="x" data-act="close" aria-label="Close">${icon('x')}</button>
    <h3 id="sh-t">${appr ? `Approve round ${p.round}` : `Request changes on round ${p.round}`}</h3>
    <p class="lead">${esc(p.title)}</p>
    ${stale ? `<div class="warn">${icon('layers', 's')}<span>The link you followed was for v${esc(sh.v)}. The plan changed since. You're ${appr ? 'approving' : 'reviewing'} v${p.short}. <a class="linkbtn" href="${planHref(p, '/diff')}" data-act="close">See what changed</a></span></div>` : ''}
    <div class="bind">${icon('lock', 's')}<span>${appr ? `Your approval binds to <b class="mono">v${p.short}</b>. Any edit to the plan needs a fresh approval.` : 'The agent stays blocked until the author sends a new round and it is approved.'}</span></div>
    ${appr && open.length ? `<div class="warn">${icon('msg', 's')}<span>${open.length} thread${open.length > 1 ? 's are' : ' is'} still open. You can approve anyway.</span></div>` : ''}
    <textarea id="stext" placeholder="${appr ? 'Optional note, e.g. “Looks right, ship it.”' : 'What needs to change? The author and their agent will see this.'}" aria-label="Note">${esc(sh.text || '')}</textarea>
    ${appr && mine.length ? `<label class="chk"><input type="checkbox" id="sres" ${sh.resolveMine ? 'checked' : ''}> Resolve my ${mine.length} open thread${mine.length > 1 ? 's' : ''}</label>` : ''}
    ${sh.err ? `<p class="err">${esc(sh.err)}</p>` : ''}
    <div class="row"><span class="hint">Posts to ${p.pr ? `PR #${p.pr.number}` : 'the PR'} · <kbd>⌘↵</kbd></span><button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn ${appr ? 'primary' : 'danger'}" data-act="sheet-submit" ${sh.state === 'posting' ? 'disabled' : ''}>${sh.state === 'posting' ? 'Posting…' : appr ? `${icon('check', 's')}Approve v${p.short}` : `${icon('undo', 's')}Request changes`}</button></div>
  </div></div>`;
}
function helpHtml() {
  const k = [['j / k', 'Move through plans'], ['Enter', 'Open plan'], ['/', 'Search'], ['g p', 'Plans'], ['g n', 'Needs you'], ['g a', 'Activity'], ['a', 'Approve'], ['r', 'Request changes'], ['c', 'Comment on selection'], ['[ / ]', 'Previous / next round'], ['n', 'Next open thread'], ['1 2 3 4', 'Plan, Rounds, Changes, Activity'], ['⌘ ↵', 'Send'], ['Esc', 'Close']];
  return `<div class="scrim" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><button class="x" data-act="close" aria-label="Close">${icon('x')}</button><h3>Keyboard shortcuts</h3><div class="help">${k.map(([a, b]) => `<div><span>${b}</span><kbd>${a}</kbd></div>`).join('')}</div></div></div>`;
}

// ---------- render ----------
let lastPage = null;
async function render() {
  route = parseRoute();
  if (route.view === 'root') return go(document.querySelector('meta[name="lake-key"]') ? '#/local' : '#/connect');
  if (route.view === 'connect') { $app.innerHTML = connectView() + (S.help ? helpHtml() : ''); return; }
  await ensureSource(route);
  if (!S.ws) { if (S.src) $app.innerHTML = `<div class="loading"><b>Could not load</b><p>${esc(S.err || '')}</p><a class="btn" href="#/connect">Back</a></div>`; return; }
  if (route.view === 'plan' && route.q.do && !S.handled.has(location.hash)) {
    S.handled.add(location.hash);
    const p = findPlan();
    if (p && S.src.canWrite && viewer() !== p.author && p.pr?.state === 'open') S.sheet = { kind: route.q.do === 'approve' ? 'approve' : 'changes', key: planKey(p), v: route.q.v || null, state: 'edit' };
    else if (p && !S.src.canWrite) setTimeout(() => toast('Connect GitHub to post your review', 'gh'), 50);
  }
  const page = location.hash.split('?')[0];
  const changed = lastPage !== page; lastPage = page;
  const main = route.view === 'plan' ? planView() : route.view === 'activity' ? teamActivity() : dash();
  $app.innerHTML = `<div class="shell">${rail()}<main id="main">${main}</main></div>${S.sheet ? sheetHtml() : ''}${S.help ? helpHtml() : ''}`;
  if (changed && !S.focus) window.scrollTo({ top: 0 });
  if (S.compose) { const t = document.getElementById('ctext'); if (t) { t.focus({ preventScroll: true }); if (S.compose.text) t.value = S.compose.text; document.getElementById('composer')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }
  if (S.sheet?.state === 'edit') document.getElementById('stext')?.focus();
  if (S.sheet?.state === 'done') document.getElementById('done-btn')?.focus();
  if (S.focus) document.getElementById(`t-${S.focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
const rerender = () => render();

// ---------- small delights ----------
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function celebrate(saved) {
  if (calm() || !(saved > 0.005)) return;
  const el = document.createElement('div'); el.className = 'drops'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = Array.from({ length: 7 }, (_, i) => `<i style="left:${12 + i * 12}%;animation-delay:${i * 60}ms"></i>`).join('') + `<b class="num">−${money(saved)}</b>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 1800);
}
function sailBoat() {
  if (document.querySelector('.boat')) return;
  const el = document.createElement('div'); el.className = 'boat'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg viewBox="0 0 64 40"><path d="M30 4v24M30 6l16 20H30z" fill="#fff" stroke="#0e7c7b" stroke-width="2" stroke-linejoin="round"/><path d="M30 10L18 26h12z" fill="#a7dbd3" stroke="#0e7c7b" stroke-width="2" stroke-linejoin="round"/><path d="M8 30h48l-6 7H14z" fill="#0e7c7b"/></svg><span></span>';
  document.body.appendChild(el); toast('Smooth sailing. Every plan floats better with a review.', 'spark');
  setTimeout(() => el.remove(), calm() ? 2500 : 9000);
}
// Type "calm" anywhere outside a field: the page settles like still water.
let typed = '';
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.key.length !== 1) return;
  typed = (typed + e.key.toLowerCase()).slice(-4);
  if (typed === 'calm') { typed = ''; document.body.classList.remove('stillwater'); void document.body.offsetWidth; document.body.classList.add('stillwater'); toast('Still water. Nothing ships without a yes.', 'spark'); setTimeout(() => document.body.classList.remove('stillwater'), 2600); }
});

async function post(p, kind, o) {
  try {
    const res = await S.src.post(p, kind, { planId: p.id, ...o });
    if (S.src.reloadPr && p.pr) {
      const r = await S.src.reloadPr(p.pr.number);
      const idx = S.ws.plans.findIndex((x) => x.pr?.number === p.pr.number);
      S.ws.plans = S.ws.plans.filter((x) => x.pr?.number !== p.pr.number);
      S.ws.plans.splice(Math.max(0, idx), 0, ...r.plans);
    } else S.ws = await S.src.load();
    track(`post-${kind}`);
    return res;
  } catch (e) { toast(esc(friendly(e.message)), 'x'); throw e; }
}
async function submitComment(p) {
  const t = document.getElementById('ctext'); const text = t?.value.trim();
  if (!text) { t?.focus(); return; }
  const c = S.compose; t.disabled = true;
  try {
    await post(p, 'comment', { version: p.digest, anchor: { start: c.s, end: c.e, quote: c.quote, heading: c.heading || undefined }, text });
    S.compose = null; toast(`Comment posted${p.pr ? ` to PR #${p.pr.number}` : ''}`, 'msg');
  } catch { t.disabled = false; return; }
  rerender();
}
async function submitSheet() {
  const sh = S.sheet; const p = findPlanById(sh.key);
  const text = (document.getElementById('stext')?.value || '').trim();
  if (sh.kind === 'changes' && !text) { sh.err = 'Add a short note so the author knows what to change.'; return rerender(); }
  sh.state = 'posting'; sh.text = text; sh.err = null; rerender();
  const resolves = sh.resolveMine ? p.threads.filter((t) => !t.resolved && !t.outdated && t.comments[0]?.login === viewer() && t.source !== 'github').map((t) => t.id) : [];
  try { sh.posted = await post(p, 'verdict', { action: sh.kind === 'approve' ? 'approve' : 'reject', version: p.digest, text, resolves }); sh.state = 'done'; }
  catch (e) { sh.state = 'edit'; sh.err = friendly(e.message); }
  rerender();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'close-bg' && e.target !== el) return;
  const p = route.view === 'plan' && S.ws ? findPlan() : null;
  switch (act) {
    case 'filter': S.filter = el.dataset.f; S.sel = 0; return go(el.dataset.f === 'needs' ? `${S.base}/needs` : S.base);
    case 'tfilter': S.tfilter = el.dataset.f; return rerender();
    case 'round': { const n = Number(el.dataset.n); S.compose = null; return go(`${planHref(p)}${n === p.round ? '' : `?round=${n}`}`); }
    case 'approve': case 'changes': S.sheet = { kind: act, key: planKey(p), state: 'edit' }; return rerender();
    case 'close': case 'close-bg': S.sheet = null; S.help = false; return rerender();
    case 'help': S.help = true; return rerender();
    case 'demo-reset': S.src.reset?.(); S.ws = await S.src.load(); S.openThreads.clear(); toast('Demo reset'); return rerender();
    case 'refresh': S.ws = await S.src.load({ fresh: true }); toast('Up to date'); return rerender();
    case 'signout': tokenStore.clear(); toast('Token removed from this browser'); return rerender();
    case 'add': {
      const s = Number(el.dataset.s); const eL = Number(el.dataset.e);
      const quote = String(p.body).split('\n').slice(s - 1, eL).join('\n').replace(/^\s*(\d+[.)]|[-*+]|#{1,6})\s+/, '').trim();
      S.compose = { s, e: eL, quote, heading: headingAt(p.body, s) }; S.focus = null;
      return rerender();
    }
    case 'compose-cancel': S.compose = null; return rerender();
    case 'compose-submit': return submitComment(p);
    case 'resolve': case 'reopen': {
      el.disabled = true;
      try { await post(p, 'resolve', { thread: el.dataset.t, resolved: act === 'resolve' }); toast(act === 'resolve' ? 'Thread resolved' : 'Thread reopened'); } catch { /* toast shown */ }
      if (act === 'reopen') S.openThreads.delete(el.dataset.t);
      return rerender();
    }
    case 'toggle-thread': if (S.openThreads.has(el.dataset.t)) S.openThreads.delete(el.dataset.t); else S.openThreads.add(el.dataset.t); return rerender();
    case 'goto-thread': {
      const t = p.threads.find((x) => x.id === el.dataset.t);
      S.focus = t.id; S.openThreads.add(t.id); S.keepFocus = true;
      if (t.outdated) return go(`${planHref(p)}?round=${t.n}`);
      if (route.q.round) return go(planHref(p));
      S.keepFocus = false; return rerender();
    }
    case 'jump': e.preventDefault(); document.querySelector(`#doc [data-s="${el.dataset.s}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    case 'expand': S.expand = !S.expand; return rerender();
    case 'sheet-submit': return submitSheet();
    case 'models-toggle': S.modelsOpen = !el.parentElement.open; return;
    case 'apply': case 'suggest': case 'use-model': case 'suggest-model': {
      const sg = act === 'apply' || act === 'suggest' ? p.suggestions.find((x) => x.id === el.dataset.sid) : { title: `Run the plan on ${p.modelOptions.find((o) => o.key === el.dataset.m)?.name || el.dataset.m}`, patch: { type: 'planModel', model: p.modelOptions.find((o) => o.key === el.dataset.m)?.name || el.dataset.m }, saving: null };
      if (!sg) return;
      el.disabled = true;
      const before = p.estimate.declared ? p.estimate.plannedUsd[1] : p.estimate.usd[1];
      try {
        if (act === 'apply' || act === 'use-model') {
          await post(p, 'accept', { title: sg.title, patch: sg.patch, thread: `self-${Date.now().toString(36)}` });
          const np = findPlan(); const after = np.estimate.declared ? np.estimate.plannedUsd[1] : np.estimate.usd[1];
          celebrate(before - after);
          toast(`Round ${np.round} is up · v${np.short}${before - after > 0.005 ? ` · ${money(before - after)} lighter` : ''}`, 'spark');
        } else {
          await post(p, 'suggest', { version: p.digest, title: sg.title, patch: sg.patch, saving: sg.saving });
          toast(`Suggested to ${esc(first(p.author))}. One click for them to accept.`, 'spark');
        }
      } catch { el.disabled = false; }
      return rerender();
    }
    case 'accept': {
      const t = p.threads.find((x) => x.id === el.dataset.t); if (!t?.suggestion) return;
      el.disabled = true; const before = p.estimate.declared ? p.estimate.plannedUsd[1] : p.estimate.usd[1];
      try {
        await post(p, 'accept', { thread: t.id, title: t.suggestion.title, patch: t.suggestion.patch });
        const np = findPlan(); const after = np.estimate.declared ? np.estimate.plannedUsd[1] : np.estimate.usd[1];
        celebrate(before - after); toast(`Accepted · round ${np.round} is up for review`, 'spark');
      } catch { el.disabled = false; }
      return rerender();
    }
    case 'boat': { S.boat = (S.boat || 0) + 1; if (S.boat >= 5) { S.boat = 0; sailBoat(); } return; }
    case 'sel-comment': { const c = S.pendingSel; document.querySelector('.selbtn')?.remove(); if (c) { S.compose = c; S.focus = null; window.getSelection()?.removeAllRanges(); rerender(); } return; }
    default:
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset?.act === 'diffsel') {
    const p = findPlan();
    const a = el.dataset.which === 'a' ? Number(el.value) : (route.a || p.round - 1); const b = el.dataset.which === 'b' ? Number(el.value) : (route.b || p.round);
    if (a === b) return;
    go(planHref(p, `/diff/${Math.min(a, b)}/${Math.max(a, b)}`));
  }
  if (el.id === 'sres' && S.sheet) S.sheet.resolveMine = el.checked;
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; render().then(() => { const q = document.getElementById('q'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }); }
  if (e.target.id === 'stext' && S.sheet) S.sheet.text = e.target.value;
  if (e.target.id === 'ctext' && S.compose) S.compose.text = e.target.value;
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'connect') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const repo = String(f.get('repo') || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { route.q.err = 'Use the owner/repo form, e.g. acme/api.'; $app.innerHTML = connectView(); return; }
  const tok = String(f.get('tok') || '').trim();
  if (tok) tokenStore.set(tok, !!f.get('remember'));
  S.src = null; S.base = null;
  go(`#/r/${repo}`);
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (S.sheet || S.help) { S.sheet = null; S.help = false; return rerender(); }
    if (S.compose) { S.compose = null; return rerender(); }
    document.querySelector('.selbtn')?.remove();
    if (typing) document.activeElement.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (S.sheet?.state === 'edit') { e.preventDefault(); return submitSheet(); }
    if (S.compose) { e.preventDefault(); return submitComment(findPlan()); }
  }
  if (typing) {
    const inp = document.activeElement;
    if (e.key === 'Enter' && inp.dataset.reply) {
      const text = inp.value.trim(); if (!text) return;
      inp.disabled = true; const p = findPlan(); const t = inp.dataset.reply;
      post(p, 'reply', { thread: t, text }).then(() => { toast('Reply posted', 'msg'); S.focus = t; rerender(); }).catch(() => { inp.disabled = false; });
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || S.sheet) return;
  const k = e.key;
  if (k === '?') { S.help = true; return rerender(); }
  if (S.gPending) { S.gPending = false; if (k === 'p') return go(S.base); if (k === 'a') return go(`${S.base}/activity`); if (k === 'n') return go(`${S.base}/needs`); }
  if (k === 'g') { S.gPending = true; setTimeout(() => { S.gPending = false; }, 900); return; }
  if (!S.ws) return;
  if (route.view === 'dash') {
    const list = filtered();
    const move = (d) => { S.sel = Math.max(0, Math.min(list.length - 1, S.sel + d)); e.preventDefault(); rerender().then(() => document.querySelector('.prow.sel')?.scrollIntoView({ block: 'nearest' })); };
    if (k === 'j' || k === 'ArrowDown') return move(1);
    if (k === 'k' || k === 'ArrowUp') return move(-1);
    if (k === 'Enter' && list[S.sel]) return go(planHref(list[S.sel]));
    if (k === '/') { e.preventDefault(); document.getElementById('q')?.focus(); }
    return;
  }
  if (route.view === 'plan') {
    const p = findPlan(); if (!p) return;
    const canAct = S.src.canWrite && viewer() !== p.author && p.pr?.state === 'open';
    if ((k === 'a' || k === 'r') && canAct) { S.sheet = { kind: k === 'a' ? 'approve' : 'changes', key: planKey(p), state: 'edit' }; e.preventDefault(); return rerender(); }
    if (k === 'c' && S.pendingSel) { S.compose = S.pendingSel; document.querySelector('.selbtn')?.remove(); e.preventDefault(); return rerender(); }
    const n = Number(route.q.round) || p.round;
    if (k === '[' && n > 1) return go(`${planHref(p)}?round=${n - 1}`);
    if (k === ']' && n < p.round) return go(n + 1 === p.round ? planHref(p) : `${planHref(p)}?round=${n + 1}`);
    if (k === '1') return go(planHref(p));
    if (k === '2') return go(planHref(p, '/rounds'));
    if (k === '3' && p.round > 1) return go(planHref(p, '/diff'));
    if (k === '4') return go(planHref(p, '/activity'));
    if (k === 'n') { const open = p.threads.filter((t) => !t.resolved && !t.outdated); if (!open.length) return; const i = open.findIndex((t) => t.id === S.focus); S.focus = open[(i + 1) % open.length].id; return rerender(); }
  }
});
// Select text in the plan → floating "Comment" button
document.addEventListener('mouseup', (ev) => {
  if (ev.target.closest('.selbtn')) return;
  setTimeout(() => {
    document.querySelector('.selbtn')?.remove(); S.pendingSel = null;
    if (route.view !== 'plan' || route.tab !== 'plan' || route.q.round || !S.src?.canWrite) return;
    const sel = window.getSelection(); const text = sel?.toString().trim();
    if (!text || !sel.rangeCount) return;
    const a = sel.anchorNode?.parentElement?.closest('[data-s]'); const b = sel.focusNode?.parentElement?.closest('[data-s]');
    if (!a || !b || !document.getElementById('doc')?.contains(a)) return;
    const p = findPlan(); if (!p?.pr || p.pr.state !== 'open') return;
    const s = Math.min(Number(a.dataset.s), Number(b.dataset.s)); const eL = Math.max(Number(a.dataset.e), Number(b.dataset.e));
    S.pendingSel = { s, e: eL, quote: text.slice(0, 300), heading: headingAt(p.body, s) };
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const btn = document.createElement('div'); btn.className = 'selbtn';
    btn.style.left = `${r.left + r.width / 2 + scrollX}px`; btn.style.top = `${r.top + scrollY - 8}px`;
    btn.innerHTML = `<button class="btn sm primary" data-act="sel-comment">${icon('msg', 's')}Comment <span class="k">C</span></button>`;
    document.body.appendChild(btn);
  }, 0);
});
window.addEventListener('hashchange', () => { if (!S.keepFocus) S.focus = null; S.keepFocus = false; render(); });
if (/\.github\.io$/.test(location.hostname)) {
  const s = document.createElement('script'); s.async = true; s.src = 'https://gc.zgo.at/count.js'; s.dataset.goatcounter = 'https://lakehq.goatcounter.com/count'; document.head.appendChild(s);
}
render();

// Data sources for the review UI. All of them produce the same workspace shape from core/review.js.
//  demo   – fictional team, in memory
//  github – reads/writes a GitHub repo straight from the browser (token stays in this browser)
//  local  – served by `npx lake-gate ui`: GitHub calls go through a localhost proxy that holds your
//           gh/GITHUB_TOKEN, plus plans in your working tree that aren't on a PR yet
import { client } from './core/github.js';
import { loadWorkspace, loadPr, actions, viewer as whoami } from './core/workspace.js';
import { buildPlanReview, versionsFromSnapshots } from './core/review.js';
import { safeParseConfig } from './core/config-core.js';
import { demoWorkspace, demoPost, demoReset, VIEWER, PEOPLE } from './demo.js';
import { commentBody, replyBody, resolveBody, verdictBody, suggestionBody, acceptBody } from './core/review.js';
import { demoAccept } from './demo.js';

const BODY = { comment: commentBody, reply: replyBody, resolve: resolveBody, verdict: verdictBody, suggest: suggestionBody, accept: acceptBody };
const TOKEN_KEY = 'lake.gh.token';

export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '',
  set: (t, remember) => { sessionStorage.setItem(TOKEN_KEY, t); if (remember) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); },
  clear: () => { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); },
};

export function demoSource() {
  return {
    mode: 'demo', repo: 'fernwood/payments-api', canWrite: true, viewer: VIEWER, people: PEOPLE,
    async load() { return demoWorkspace(); },
    async post(plan, kind, o) {
      if (kind === 'accept') o = { ...o, newVersion: demoAccept(plan.pr.number, o.patch) };
      const body = BODY[kind]({ ...o, via: 'Lake review' });
      demoPost(plan.pr.number, body);
      return { body, where: `PR #${plan.pr.number}` };
    },
    reset: demoReset,
  };
}

function ghSource({ repo, gh, mode, extraPlans, canAuth = true }) {
  let ws = null; let me = null;
  return {
    mode, repo, people: {}, get canWrite() { return !!me; }, get viewer() { return me; }, gh,
    // focus: a PR number from a deep link. Without a token only that PR is read (GitHub allows 60 calls/hour).
    async load({ focus = null, fresh = false } = {}) {
      if (fresh) gh.refresh?.();
      me = me || (canAuth ? (await whoami(gh))?.login : null) || null; // no token: don't ask GitHub who we are
      const r = await loadWorkspace(gh, canAuth ? { state: 'all', limit: 20 } : focus ? { focus } : { state: 'open', limit: 10 });
      const local = extraPlans ? await extraPlans(r.plans) : [];
      ws = { repo, plans: [...r.plans, ...local], viewer: me, people: {}, mode, partial: r.partial ? focus : null, limited: !canAuth };
      return ws;
    },
    async post(plan, kind, o) {
      if (!plan.pr) throw new Error('This plan is not on a pull request yet. Push it and open a PR first.');
      await actions[kind](gh, plan.pr.number, { ...o, via: 'Lake review' });
      return { body: kind === 'accept' ? `Committed the change to ${plan.path} on ${plan.pr.branch}` : BODY[kind]({ ...o, via: 'Lake review' }), where: `PR #${plan.pr.number}` };
    },
    async reloadPr(number) { gh.refresh?.(); return loadPr(gh, number); },
  };
}

// GitHub responses kept in this browser: commit-pinned files forever, the rest reused for a short while and then
// revalidated with ETags. Public data only goes to localStorage (no token); with a token, sessionStorage.
function browserCache(store, prefix = 'lake.c.') {
  const max = 400;
  return {
    get(k) { try { const v = store.getItem(prefix + k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) {
      const put = () => store.setItem(prefix + k, JSON.stringify(v));
      try { put(); } catch { // full: drop our oldest entries and retry once
        try {
          const keys = []; for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key.startsWith(prefix)) keys.push(key); }
          keys.map((key) => [key, (() => { try { return JSON.parse(store.getItem(key)).at || 0; } catch { return 0; } })()]).sort((a, b) => a[1] - b[1]).slice(0, Math.max(keys.length / 2, keys.length - max)).forEach(([key]) => store.removeItem(key));
          put();
        } catch { /* cache is best effort */ }
      }
    },
  };
}

export function githubSource(repo) {
  const token = tokenStore.get();
  let cache = null;
  try { cache = browserCache(token ? sessionStorage : localStorage); } catch { /* storage blocked */ }
  const gh = client({ token: token || undefined, repo, fetchImpl: (u, o) => fetch(u, o), cache, freshMs: token ? 30_000 : 5 * 60_000 });
  return ghSource({ repo, gh, mode: 'github', canAuth: !!token });
}

export async function localSource() {
  const key = document.querySelector('meta[name="lake-key"]')?.content;
  if (!key) return null;
  const env = await fetch('/api/env', { headers: { 'X-Lake-Key': key } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!env) return null;
  const fetchImpl = (u, o = {}) => fetch(u, { ...o, headers: { ...(o.headers || {}), 'X-Lake-Key': key } });
  const gh = env.repo ? client({ repo: env.repo, api: '/gh', fetchImpl }) : null;
  // Local plans not on any PR (or edited locally) show as drafts.
  const extraPlans = async (prPlans) => {
    const local = await fetchImpl('/api/local').then((r) => r.json());
    const config = safeParseConfig(local.config);
    const out = [];
    for (const lp of local.plans) {
      const versions = versionsFromSnapshots(lp.snapshots, lp.id);
      if (!versions.length) continue;
      const cur = versions[versions.length - 1];
      const onPr = prPlans.find((p) => p.id === cur.id && p.pr?.state === 'open');
      if (onPr && onPr.digest === cur.digest) continue;
      const m = buildPlanReview({ plan: cur, versions, events: [], config });
      m.local = { branch: local.branch, unpushed: !!onPr, prNumber: onPr?.pr.number || null };
      if (onPr) m.id = cur.id; // same id, local edit
      out.push(m);
    }
    return out;
  };
  if (!gh) {
    return { mode: 'local', repo: env.root, canWrite: false, viewer: null, people: {},
      async load() { return { repo: env.root, plans: await extraPlans([]), viewer: null, people: {}, mode: 'local' }; }, async post() { throw new Error('No GitHub remote.'); } };
  }
  const s = ghSource({ repo: env.repo, gh, mode: 'local', extraPlans });
  s.env = env;
  return s;
}

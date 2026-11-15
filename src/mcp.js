// lake-gate MCP server (stdio). Lets Claude Code, Cursor or any MCP client:
//   author side:   request review on a plan, wait for the verdict, read anchored feedback, submit a revision;
//   reviewer side: read a plan with its threads, reply, approve or request changes from the agent chat.
// Everything is read from and written to the PR (the single source of truth), with the GitHub token
// already on this machine (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). No Lake server.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { repoRoot, loadPlan, getState, exportPlan, listPlans } from './store.js';
import { client } from './github.js';
import { parseRemote, applyEvents } from './sync.js';
import { collectEvents, nativeDigests } from './github.js';
import { loadPr, actions } from './workspace.js';
import { loadConfig } from './config.js';
import { range } from './estimate.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sh = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });

export const TOOLS = [
  { name: 'lake_request_review', description: 'Save a plan (markdown) as a versioned lake-gate plan and ask teammates to review it on the PR. Returns the plan id, version, cost estimate and review link. Use after planning, before implementing.',
    inputSchema: S({ plan_markdown: str('Full plan in markdown. Omit to request review of an existing plan.'), plan_id: str('Plan id (defaults to the active plan, or derived from the title)'),
      reviewers: { type: 'array', items: { type: 'string' }, description: 'GitHub logins to request review from' }, note: str('Short note to reviewers'),
      push: { type: 'boolean', description: 'Commit only the plan file and push the current branch (so the PR shows this version)' } }), annotations: { openWorldHint: true } },
  { name: 'lake_review_status', description: 'Current review state of a plan on its PR: status, verdicts with reviewer notes, and open comment threads anchored to plan sections. Set wait_seconds to wait for a decision or new feedback. Also syncs approvals locally so the lake-gate hook opens once approved.',
    inputSchema: S({ plan_id: str('Plan id (defaults to the active plan)'), wait_seconds: { type: 'number', minimum: 0, maximum: 240, description: 'Wait up to this long for a change (polls every 20s)' } }), annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'lake_submit_revision', description: 'Save a revised plan as a new version (this invalidates earlier approvals), mark addressed threads resolved and tell reviewers on the PR.',
    inputSchema: S({ plan_markdown: str('Full revised plan in markdown'), plan_id: str('Plan id (defaults to the active plan)'), addressed_threads: { type: 'array', items: { type: 'string' }, description: 'Thread ids this revision addresses' },
      note: str('What changed, for reviewers'), push: { type: 'boolean', description: 'Commit only the plan file and push' } }, ['plan_markdown']), annotations: { openWorldHint: true } },
  { name: 'lake_reply', description: 'Reply in a comment thread on a plan.', inputSchema: S({ thread_id: str('Thread id from lake_review_status'), text: str('Reply text'), plan_id: str('Plan id') }, ['thread_id', 'text']), annotations: { openWorldHint: true } },
  { name: 'lake_comment', description: 'Add a review comment anchored to a line range of the current plan version.',
    inputSchema: S({ plan_id: str('Plan id'), line: { type: 'number', description: 'First line (as shown by lake_review_status)' }, end_line: { type: 'number' }, text: str('Comment') }, ['line', 'text']), annotations: { openWorldHint: true } },
  { name: 'lake_approve', description: 'Approve the exact plan version as the human reviewer on this machine. ONLY call when the user has explicitly said to approve this plan in this conversation. Posts on the PR as the GitHub account of this machine; plan authors cannot approve their own plan.',
    inputSchema: S({ plan_id: str('Plan id'), version: str('8-character version the user approved (from lake_review_status)'), comment: str('Optional note') }, ['plan_id', 'version']), annotations: { openWorldHint: true, destructiveHint: false } },
  { name: 'lake_request_changes', description: 'Request changes on the exact plan version as the human reviewer on this machine. ONLY call when the user explicitly asked for it. Blocks the plan until that reviewer approves a version.',
    inputSchema: S({ plan_id: str('Plan id'), version: str('8-character version'), comment: str('What needs to change') }, ['plan_id', 'version', 'comment']), annotations: { openWorldHint: true } },
];

// Context: repo root + lazily resolved GitHub client and PR. Tests inject gh/prNumber/sleep.
export function createContext({ root = repoRoot(), gh, prNumber, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clientName = 'MCP client', token } = {}) {
  const ctx = { root, sleep, clientName };
  ctx.github = () => {
    if (gh) return gh;
    const repo = parseRemote(sh('git', ['remote', 'get-url', 'origin'], root));
    if (!repo) throw new Error('No GitHub remote named origin.');
    const t = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || sh('gh', ['auth', 'token'], root);
    if (!t) throw new Error('Need GitHub access: set GITHUB_TOKEN or run `gh auth login`.');
    gh = client({ token: t, repo });
    return gh;
  };
  ctx.pr = async () => {
    if (prNumber) return prNumber;
    const g = ctx.github();
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const prs = await g.req('GET', `/pulls?state=open&head=${encodeURIComponent(`${g.owner}:${branch}`)}`);
    if (!prs || !prs.length) return null;
    prNumber = prs[0].number;
    return prNumber;
  };
  return ctx;
}

const reviewLink = (cfg, repo, pr, id, act) => (cfg.reviewUrl && repo && pr ? `${cfg.reviewUrl}#/pr/${repo}/${pr}/${encodeURIComponent(id)}${act ? `?do=${act}` : ''}` : null);

function resolveId(ctx, id) {
  const pid = id || getState(ctx.root).active;
  if (!pid) throw new Error('No plan id given and no active plan.');
  return pid;
}

function pushPlan(ctx, id, message) {
  const p = `.lake/plans/${id}.md`;
  sh('git', ['add', p], ctx.root);
  const c = sh('git', ['commit', '-m', message, '--only', p], ctx.root);
  const pushed = sh('git', ['push', '-u', 'origin', 'HEAD'], ctx.root);
  return c !== null && pushed !== null ? `Committed and pushed ${p}.` : `Could not commit/push ${p} automatically; commit and push it yourself.`;
}

async function prModel(ctx, id) {
  const number = await ctx.pr();
  if (!number) return { number: null, model: null };
  const r = await loadPr(ctx.github(), number);
  return { number, model: r.plans.find((p) => p.id === id) || null, config: r.config, events: r.events, pr: r.pr };
}

export function formatReview(m, { localDigest, link } = {}) {
  const L = [];
  L.push(`Plan ${m.id} · v${m.short} (round ${m.round}) · status: ${m.status}${m.policy.needed && m.status === 'in-review' ? ` · needs ${m.policy.needed} more approval(s)` : ''}`);
  L.push(`Estimate: ${m.estimate.complexity} complexity, ${range(m.estimate.usd)}`);
  if (localDigest && localDigest !== m.digest) L.push(`Note: your local plan file is a different version (${localDigest.slice(0, 8)}) than the PR (${m.short}). Push it so reviewers see it.`);
  const cur = m.verdicts.filter((v) => v.version === m.digest && v.action !== 'revoke');
  if (cur.length) { L.push('', 'Verdicts on this version:'); for (const v of cur) L.push(`- @${v.login} ${v.action === 'approve' ? 'approved' : 'requested changes'}${v.self ? ' (author, does not count)' : ''} via ${v.via}${v.text ? `: ${v.text.replace(/\n+/g, ' ')}` : ''}`); }
  const prev = m.verdicts.filter((v) => v.version !== m.digest && v.action === 'reject');
  if (prev.length) { L.push('', 'Earlier rounds:'); for (const v of prev) L.push(`- round ${v.n}: @${v.login} requested changes${v.text ? `: ${v.text.replace(/\n+/g, ' ')}` : ''}`); }
  const open = m.threads.filter((t) => !t.resolved);
  if (open.length) {
    L.push('', `Open threads (${open.length}):`);
    for (const t of open) {
      const where = t.anchor ? `${t.anchor.heading ? `"${t.anchor.heading}", ` : ''}line ${t.current ? t.current.start : t.anchor.start}${t.outdated ? ' (outdated: text changed)' : ''}` : 'whole plan';
      L.push(`- [${t.id}] round ${t.n}, ${where}${t.anchor?.quote ? ` on: "${t.anchor.quote.split('\n')[0].slice(0, 120)}"` : ''}`);
      for (const c of t.comments) L.push(`    @${c.login}: ${String(c.text).replace(/\n+/g, ' ')}`);
    }
  }
  const lines = String(m.body).split('\n');
  L.push('', 'Plan text with line numbers (for anchoring comments):', ...lines.slice(0, 400).map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).filter((l) => !/lake:estimate/.test(l)));
  if (link) L.push('', `Review page: ${link}`);
  return L.join('\n');
}

export async function callTool(ctx, name, a = {}) {
  const via = `${ctx.clientName} (MCP)`;
  switch (name) {
    case 'lake_request_review': {
      let plan; let note = '';
      if (a.plan_markdown) { const r = exportPlan(ctx.root, a.plan_markdown, { id: a.plan_id, source: 'mcp' }); plan = r.plan; }
      else { plan = loadPlan(ctx.root, resolveId(ctx, a.plan_id)); if (!plan) throw new Error(`No plan ${a.plan_id}`); }
      const cfg = loadConfig(ctx.root);
      if (a.push) note += '\n' + pushPlan(ctx, plan.id, `Plan: ${plan.title} (v${plan.short})`);
      const number = await ctx.pr().catch(() => null);
      if (!number) return `Saved .lake/plans/${plan.id}.md as v${plan.short}.${note}\nNo open PR for this branch yet: commit and push the plan, open a (draft) PR, then call lake_request_review again or lake_review_status.`;
      const g = ctx.github();
      if (a.reviewers?.length) await g.req('POST', `/pulls/${number}/requested_reviewers`, { reviewers: a.reviewers }).catch(() => null);
      const link = reviewLink(cfg, g.repo, number, plan.id);
      await g.req('POST', `/issues/${number}/comments`, { body: [`**Plan ready for review:** ${plan.title} · \`${plan.id}\` v${plan.short}`, a.reviewers?.length ? a.reviewers.map((r) => '@' + r).join(' ') : null,
        a.note ? `\n${a.note}` : null, link ? `\n[Open the plan review](${link})` : null, `\n<sub>via lake-gate · ${via}</sub>`].filter(Boolean).join('\n') });
      return `Review requested on PR #${number} for ${plan.id} v${plan.short}.${note}${link ? `\nReview page: ${link}` : ''}\nCall lake_review_status with wait_seconds to wait for feedback. Do not implement until it is approved.`;
    }
    case 'lake_review_status': {
      const id = resolveId(ctx, a.plan_id);
      const local = loadPlan(ctx.root, id);
      let { number, model, config, events, pr } = await prModel(ctx, id);
      if (!number) return `No open PR for this branch. Push the plan and open a PR first.${local ? ` Local plan ${id} is v${local.short}.` : ''}`;
      if (!model) return `PR #${number} does not contain .lake/plans/${id}.md yet. Push the plan file.`;
      const wait = Math.min(240, Math.max(0, Number(a.wait_seconds) || 0));
      const sig = (m) => `${m.status}|${m.digest}|${m.verdicts.length}|${m.threads.reduce((n, t) => n + t.comments.length, 0)}`;
      const start = sig(model); let waited = 0;
      while (waited < wait && sig(model) === start) {
        await ctx.sleep(20000); waited += 20;
        ({ model, config, events, pr } = await prModel(ctx, id));
      }
      // Sync locally so the Claude Code hook sees the decision.
      try {
        const digestAt = {}; const raw = await collectEvents(ctx.github(), number);
        for (const p of listPlans(ctx.root)) digestAt[p.id] = await nativeDigests(ctx.github(), raw, `.lake/plans/${p.id}.md`, { headSha: pr.head.sha, config });
        applyEvents(ctx.root, { events: raw, prAuthor: pr.user.login, prNumber: number, digestAt });
      } catch { /* status is still useful without a local sync */ }
      const changed = waited && sig(model) !== start ? `Changed after ${waited}s.\n` : waited ? `No change after ${waited}s.\n` : '';
      return changed + formatReview(model, { localDigest: local?.digest, link: reviewLink(config, ctx.github().repo, number, id) });
    }
    case 'lake_submit_revision': {
      const id = resolveId(ctx, a.plan_id);
      const { plan } = exportPlan(ctx.root, a.plan_markdown, { id, source: 'mcp' });
      let note = '';
      if (a.push) note = '\n' + pushPlan(ctx, plan.id, `Plan revision: ${plan.title} (v${plan.short})`);
      const number = await ctx.pr().catch(() => null);
      if (number) {
        const g = ctx.github();
        await g.req('POST', `/issues/${number}/comments`, { body: [`**Revised plan \`${plan.id}\` → v${plan.short}.** Earlier approvals no longer apply.`, a.note ? `\n${a.note}` : null,
          a.addressed_threads?.length ? `\nAddressed ${a.addressed_threads.length} thread(s).` : null, `\n<sub>via lake-gate · ${via}</sub>`,
          ...(a.addressed_threads || []).map((t) => `<!-- lake:resolve ${JSON.stringify({ p: plan.id, t, r: true })} -->`)].filter(Boolean).join('\n') });
      }
      return `Saved ${plan.id} v${plan.short}.${note}${number ? ` Posted the revision on PR #${number}.` : ' No PR found to notify.'}${a.push ? '' : ' Push the plan file so reviewers see this version.'} Call lake_review_status with wait_seconds to wait.`;
    }
    case 'lake_reply': {
      const number = await ctx.pr(); if (!number) throw new Error('No open PR for this branch.');
      await actions.reply(ctx.github(), number, { planId: resolveId(ctx, a.plan_id), thread: a.thread_id, text: a.text, via });
      return `Replied in thread ${a.thread_id} on PR #${number}.`;
    }
    case 'lake_comment': {
      const id = resolveId(ctx, a.plan_id);
      const { number, model } = await prModel(ctx, id);
      if (!model) throw new Error(`No PR with plan ${id}.`);
      const lines = String(model.body).split('\n'); const s = Math.max(1, Math.floor(a.line)); const e = Math.max(s, Math.floor(a.end_line || s));
      await actions.comment(ctx.github(), number, { planId: id, version: model.digest, anchor: { start: s, end: e, quote: lines.slice(s - 1, e).join('\n') }, text: a.text, via });
      return `Commented on ${id} v${model.short}, line ${s}${e > s ? `–${e}` : ''}.`;
    }
    case 'lake_approve': case 'lake_request_changes': {
      const id = a.plan_id;
      const { number, model } = await prModel(ctx, id);
      if (!model) throw new Error(`No open PR with plan ${id}.`);
      const v = String(a.version || '').toLowerCase();
      if (v.length < 7 || !model.digest.startsWith(v)) return `Not posted: version ${a.version || '(none)'} is not the current version of ${id}. The current version is ${model.short}. Show the user what changed and ask again.`;
      if (name === 'lake_request_changes' && !String(a.comment || '').trim()) return 'Not posted: say what needs to change.';
      await actions.verdict(ctx.github(), number, { action: name === 'lake_approve' ? 'approve' : 'reject', planId: id, version: model.digest, text: a.comment, via });
      return `${name === 'lake_approve' ? 'Approved' : 'Requested changes on'} ${id} v${model.short} on PR #${number}. The PR check updates in a few seconds. If you are the PR author it will not count.`;
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

// Minimal MCP stdio transport: newline-delimited JSON-RPC 2.0.
export function serve({ input = process.stdin, output = process.stdout, ctxOptions = {} } = {}) {
  let ctx = null;
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  const handle = async (msg) => {
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    try {
      if (method === 'initialize') {
        ctx = createContext({ ...ctxOptions, clientName: params?.clientInfo?.name || 'MCP client' });
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lake-gate', version: VERSION },
          instructions: 'Plan review for coding agents. Request review after planning, wait for approval with lake_review_status, revise with lake_submit_revision. Only approve when the human explicitly says so.' } });
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        ctx = ctx || createContext(ctxOptions);
        try {
          const text = await callTool(ctx, params.name, params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `lake-gate: ${e.message}` }], isError: true } }); }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
  };
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(msg);
    }
  });
  return new Promise((resolve) => input.on('end', resolve));
}

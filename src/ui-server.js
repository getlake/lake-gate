// `lake-gate ui`: serves the Lake review UI on localhost for the current repo.
// - Static UI from ../ui and the browser-safe core modules from ./ (same code the CLI and Action use).
// - /gh/* is a narrow proxy to api.github.com for THIS repo only, using the token already on this machine
//   (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). The browser never sees the token.
// - /api/local lists plan files in the working tree with their git history (drafts that aren't on a PR yet).
// Every API call needs a per-run random key that is only embedded in the served page (blocks other sites).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRemote } from './sync.js';
import { plansDir } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'ui');
export const CORE_FILES = ['plan.js', 'sha256.js', 'estimate.js', 'policy.js', 'config-core.js', 'review.js', 'workspace.js', 'github.js'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const sh = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch { return null; } };

export function localPlans(root) {
  const dir = plansDir(root);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
  const plans = files.map((f) => {
    const rel = `.lake/plans/${f}`;
    const log = (sh('git', ['log', '--format=%H%x09%aI%x09%an', '--', rel], root) || '').trim().split('\n').filter(Boolean).reverse().slice(-30);
    const snapshots = log.map((l) => { const [sha, at, author] = l.split('\t'); return { sha, at, author, text: sh('git', ['show', `${sha}:${rel}`], root) }; }).filter((s) => s.text != null);
    const work = fs.readFileSync(path.join(dir, f), 'utf8');
    snapshots.push({ sha: null, at: fs.statSync(path.join(dir, f)).mtime.toISOString(), author: (sh('git', ['config', 'user.name'], root) || '').trim() || null, text: work });
    return { id: f.slice(0, -3), snapshots };
  });
  const cfg = path.join(root, '.lake', 'config.json');
  return { branch: (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root) || '').trim(), config: fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null, plans };
}

export function createUiServer({ root, token, api = 'https://api.github.com', fetchImpl = globalThis.fetch, key = crypto.randomBytes(16).toString('hex') } = {}) {
  const repo = parseRemote((sh('git', ['remote', 'get-url', 'origin'], root) || '').trim());
  const index = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8').replace('<!--LAKE_KEY-->', `<meta name="lake-key" content="${key}">`);
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(body); };
  const json = (res, code, v) => send(res, code, JSON.stringify(v));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      const isApi = p.startsWith('/api/') || p.startsWith('/gh/');
      if (isApi && req.headers['x-lake-key'] !== key) return json(res, 403, { message: 'Missing or wrong UI key' });
      if (p === '/api/env') return json(res, 200, { mode: 'local', repo, root: path.basename(root), hasToken: !!token });
      if (p === '/api/local') return json(res, 200, localPlans(root));
      if (p.startsWith('/gh/')) {
        // Only this repo's endpoints (and /user), only the methods the UI needs.
        const target = p.slice(3);
        const allowed = target === '/user' || (repo && target.startsWith(`/repos/${repo}/`));
        if (!allowed || !['GET', 'POST', 'PATCH'].includes(req.method)) return json(res, 403, { message: 'Not allowed through the local proxy' });
        if (req.method !== 'GET' && !/^\/repos\/[^/]+\/[^/]+\/(issues\/\d+\/comments|pulls\/\d+\/comments\/\d+\/replies)$/.test(target)) return json(res, 403, { message: 'Only posting comments is allowed' });
        if (!token) return json(res, 401, { message: 'No GitHub token: set GITHUB_TOKEN or run `gh auth login`, then restart lake-gate ui.' });
        let body; if (req.method !== 'GET') { const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks).toString('utf8'); }
        const r = await fetchImpl(`${api}${target}${url.search}`, { method: req.method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'lake-gate-ui', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body });
        return send(res, r.status, await r.text(), 'application/json');
      }
      if (req.method !== 'GET') return json(res, 405, { message: 'Method not allowed' });
      if (p === '/' || p === '/index.html') return send(res, 200, index, TYPES['.html']);
      let file;
      if (p.startsWith('/core/')) { const name = p.slice(6); if (!CORE_FILES.includes(name)) return send(res, 404, 'Not found', 'text/plain'); file = path.join(HERE, name); }
      else { file = path.join(UI_DIR, path.normalize(p).replace(/^([/\\])+/, '')); if (!file.startsWith(UI_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain'); }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    } catch (e) { return json(res, 500, { message: e.message }); }
  });
  return { server, key, repo };
}

export async function startUi({ root, port = 4848, host = '127.0.0.1', open = true, token } = {}) {
  token = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (sh('gh', ['auth', 'token'], root) || '').trim() || null;
  const { server, repo } = createUiServer({ root, token });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const url = `http://${host}:${server.address().port}/#/local`;
  if (open) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'; try { execFileSync(cmd, [url], { stdio: 'ignore' }); } catch { /* print only */ } }
  return { server, url, repo, hasToken: !!token };
}

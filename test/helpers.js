import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'maya@example.com'); g('config', 'user.name', 'Maya');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n');
  g('add', '.'); g('commit', '-qm', 'init');
  return dir;
}

export const PLAN = `# Add webhook retries

Context: deliveries fail silently today.

1. Add a bounded retry queue with exponential backoff in src/webhooks/queue.ts
2. Reuse the idempotency record so retries never double-charge (database migration for a retry_count column)
3. Fix typo in README
4. Add replay and failure tests
`;

export function fakeGitHub({ prAuthor = 'maya', files = [], contents = {}, baseConfig = '{"autoApprove":{"mode":"shadow"}}', comments = [], reviews = [] } = {}) {
  const calls = [];
  const pr = { number: 7, user: { login: prAuthor }, head: { sha: 'headsha' }, base: { sha: 'basesha' } };
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/acme/app', ''); const m = opts.method;
    calls.push({ m, p, body: opts.body ? JSON.parse(opts.body) : null, page: u.searchParams.get('page') });
    const page = Number(u.searchParams.get('page') || 1);
    const list = (arr) => json(page === 1 ? arr : []);
    if (m === 'GET' && p === '/pulls/7') return json(pr);
    if (m === 'GET' && p === '/pulls/7/files') return list(files.map((f) => ({ filename: f, status: 'modified' })));
    if (m === 'GET' && p === '/issues/7/comments') return list(comments);
    if (m === 'GET' && p === '/pulls/7/reviews') return list(reviews);
    if (m === 'GET' && p.startsWith('/contents/')) {
      const f = decodeURIComponent(p.slice('/contents/'.length)); const ref = u.searchParams.get('ref');
      const v = f === '.lake/config.json' ? (ref === 'basesha' ? baseConfig : contents[f + '@head-config']) : ref === 'headsha' ? contents[f] : null;
      return v == null ? json({ message: 'Not Found' }, 404) : json({ content: Buffer.from(v).toString('base64') });
    }
    if (m === 'GET' && p === '/pulls') return json([pr]);
    if (m === 'POST' || m === 'PATCH') return json({ id: 1 }, 201);
    return json({ message: 'unexpected ' + p }, 404);
  };
  return { fetchImpl, calls, pr };
}

export const comment = (login, body, at, extra = {}) => ({ id: Math.floor(Math.random() * 1e6), user: { login, type: extra.type || 'User' }, author_association: extra.association || 'MEMBER', body, created_at: at });

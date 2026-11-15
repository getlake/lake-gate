// Browser end-to-end (dev only): real UI + local server + fake GitHub API. Verifies the GitHub code path
// (load PR -> render rounds/threads -> one-click approve -> comment POSTed -> state re-read as approved).
const { chromium } = require(process.env.PW || '/workspace/lake/landing-tools/node_modules/playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
(async () => {
  const { createUiServer } = await import('../src/ui-server.js');
  const { renderPlanFile } = await import('../src/plan.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-e2e-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'n@example.com'); g('config', 'user.name', 'N'); fs.writeFileSync(path.join(repo, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'i');
  g('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const V1 = renderPlanFile({ id: 'retries', title: 'Retries', body: '# Retries\n\n## Steps\n1. Retry forever\n2. Store the payload\n', estimateMd: 'x' });
  const V2 = renderPlanFile({ id: 'retries', title: 'Retries', body: '# Retries\n\n## Steps\n1. Retry 6 times with backoff\n2. Store the payload\n', estimateMd: 'x' });
  const comments = [{ id: 1, user: { login: 'leo', type: 'User' }, author_association: 'MEMBER', created_at: '2026-11-10T11:00:00Z', body: '/lake reject retries@' + require('node:crypto').createHash('sha256').update('# Retries\n\n## Steps\n1. Retry forever\n2. Store the payload\n').digest('hex').slice(0, 8) + '\n\nBound it.' }];
  const posted = [];
  const pr = { number: 9, title: 'Retries', user: { login: 'maya' }, head: { sha: 'c2', ref: 'maya/retries' }, base: { sha: 'b' }, html_url: 'https://github.com/acme/app/pull/9', state: 'open', draft: false, requested_reviewers: [] };
  const res = (v, s = 200) => ({ status: s, text: async () => JSON.stringify(v) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); const p = u.pathname.replace('/repos/acme/app', ''); const page = Number(u.searchParams.get('page') || 1); const L = (a) => res(page === 1 ? a : []);
    if (p === '/user') return res({ login: 'noah' });
    if (p === '/pulls' ) return res([pr]);
    if (p === '/pulls/9') return res(pr);
    if (p === '/pulls/9/files') return L([{ filename: '.lake/plans/retries.md', status: 'added' }]);
    if (p === '/pulls/9/commits') return L([{ sha: 'c1', commit: { committer: { date: '2026-11-10T10:00:00Z' } } }, { sha: 'c2', commit: { committer: { date: '2026-11-11T10:00:00Z' } } }]);
    if (p === '/commits') return res([{ sha: 'c2' }, { sha: 'c1' }]);
    if (p === '/issues/9/comments' && opts.method === 'POST') { const b = JSON.parse(opts.body).body; posted.push(b); comments.push({ id: comments.length + 1, user: { login: 'noah', type: 'User' }, author_association: 'MEMBER', created_at: new Date().toISOString(), body: b }); return res(comments.at(-1), 201); }
    if (p === '/issues/9/comments') return L(comments);
    if (p === '/pulls/9/reviews' || p === '/pulls/9/comments') return L([]);
    if (p.startsWith('/contents/')) { if (p.includes('config')) return res({}, 404); const ref = u.searchParams.get('ref'); return res({ content: Buffer.from(ref === 'c1' ? V1 : V2).toString('base64') }); }
    return res({ message: 'nope ' + p }, 404);
  };
  const { server } = createUiServer({ root: repo, token: 't', fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('response', (r) => r.status() >= 400 && !/contents\/.lake\/config/.test(r.url()) && errors.push(r.status() + ' ' + r.url()));
  await page.goto(base + '#/local'); await page.waitForSelector('.prow');
  const row = await page.textContent('.prow');
  await page.click('.prow'); await page.waitForSelector('.doc');
  const rounds = await page.locator('.roundbar .rpill').count();
  await page.keyboard.press('a'); await page.fill('#stext', 'ok from e2e'); await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.done');
  await page.click('#done-btn');
  const banner = await page.textContent('.banner');
  await page.screenshot({ path: path.join(__dirname, '..', 'ui-shots', 'e2e-github-path-1440.png') });
  await browser.close(); server.close();
  const ok = /round 2/.test(row) && rounds === 2 && posted.length === 1 && /^\/lake approve retries@/.test(posted[0]) && /Approved/.test(banner) && !errors.length;
  console.log(JSON.stringify({ ok, row: row.replace(/\s+/g, ' ').trim(), rounds, posted, banner: banner.trim(), errors }, null, 1));
  process.exit(ok ? 0 : 1);
})();

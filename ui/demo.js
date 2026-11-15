// Demo workspace: a made-up team ("Fernwood", fictional people) and made-up plans.
// Raw inputs only (plan file versions + PR comments/reviews exactly as GitHub would return them);
// the real lake-gate data layer (core/review.js) builds every screen from them.
import { renderPlanFile } from './core/plan.js';
import { parseConfig } from './core/config-core.js';
import { buildPlanReview, versionsFromSnapshots, commentBody, replyBody, resolveBody, verdictBody, encodeMarker } from './core/review.js';

export const PEOPLE = {
  maya: { name: 'Maya Ortiz', role: 'Backend' },
  noah: { name: 'Noah Brandt', role: 'Tech lead' },
  ava: { name: 'Ava Lindqvist', role: 'Security' },
  leo: { name: 'Leo Park', role: 'Platform' },
  sam: { name: 'Sam Okafor', role: 'Data' },
  ines: { name: 'Inés Duarte', role: 'Product' },
};
export const VIEWER = 'noah';
export const REPO = 'fernwood/payments-api';
const CONFIG = parseConfig(JSON.stringify({ requiredApprovals: 2 }));

const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();
const file = (id, title, author, body) => renderPlanFile({ id, title, author, created: ago(4000), body, estimateMd: '' });
const bodyOf = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
function at(text, needle, span = 1) {
  const lines = bodyOf(text).split('\n'); const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error('demo anchor not found: ' + needle);
  return { start: i + 1, end: i + span, quote: lines.slice(i, i + span).join('\n') };
}
let seq = 1;
const ev = (login, body, min, extra = {}) => ({ id: `d${seq++}`, source: 'comment', login, type: 'User', association: 'MEMBER', body, createdAt: ago(min), ...extra });

// ---------- 1. Webhook retries: three rounds ----------
const W1 = file('add-webhook-retries', 'Add webhook retries', 'maya', `# Add webhook retries

Deliveries to customer endpoints fail silently today. When an endpoint times out we drop the event and the customer never hears about it.

## Goal
Retry failed deliveries without ever sending the same event twice.

## Steps
1. Add a retry queue in \`src/webhooks/queue.ts\` that retries failed deliveries every 30 seconds, forever.
2. Store the full payload on the delivery record so a retry can resend it as is.
3. Add a \`retry_count\` column to \`webhook_deliveries\` (database migration).
4. Add tests for the retry path.

## Risks
- Customers with slow endpoints get more traffic.

## Out of scope
- A dashboard for failed deliveries.
`);
const W2 = file('add-webhook-retries', 'Add webhook retries', 'maya', `# Add webhook retries

Deliveries to customer endpoints fail silently today. When an endpoint times out we drop the event and the customer never hears about it.

## Goal
Retry failed deliveries without ever sending the same event twice.

## Steps
1. Add a bounded retry queue in \`src/webhooks/queue.ts\`: exponential backoff from 30s, capped at 6 attempts over about 2 hours.
2. After the last attempt, move the delivery to a \`dead_letter\` state and notify the account owner by email.
3. Store the full payload on the delivery record so a retry can resend it as is.
4. Reuse the existing idempotency key on every attempt so a retry never double-charges.
5. Add a \`retry_count\` column to \`webhook_deliveries\` (database migration).
6. Add tests for backoff, dead-letter and idempotent replay.

## Risks
- Customers with slow endpoints get more traffic.

## Out of scope
- A dashboard for failed deliveries.
`);
const W3 = file('add-webhook-retries', 'Add webhook retries', 'maya', `# Add webhook retries

Deliveries to customer endpoints fail silently today. When an endpoint times out we drop the event and the customer never hears about it.

## Goal
Retry failed deliveries without ever sending the same event twice, and never send a payload we can't vouch for.

## Steps
1. Add a bounded retry queue in \`src/webhooks/queue.ts\`: exponential backoff from 30s with jitter, capped at 6 attempts over about 2 hours.
2. After the last attempt, move the delivery to a \`dead_letter\` state and notify the account owner by email.
3. Store the event id and body on the delivery record, and re-sign every attempt with the current signing key. Refuse to send if that key has expired.
4. Reuse the existing idempotency key on every attempt so a retry never double-charges.
5. Add a \`retry_count\` column to \`webhook_deliveries\` (database migration, backfill 0).
6. Emit \`webhook.retry\` and \`webhook.dead_letter\` metrics.
7. Add tests for backoff, dead-letter, expired keys and idempotent replay.

## Risks
- Customers with slow endpoints get more traffic. Jitter spreads it out.
- The backfill touches about 9M rows. Run it in batches of 50k off-peak.

## Out of scope
- A dashboard for failed deliveries.
`);
const webhookEvents = [];
{
  const t1 = 'w1forevr', t2 = 'w1idempo', t3 = 'w1paylod', t4 = 'w2resign', t5 = 'w3keyid';
  webhookEvents.push(
    ev('maya', `**Plan ready for review:** Add webhook retries\n@noah @ava\n\nFirst cut. Mostly worried about the migration size.\n<sub>via lake-gate · Claude Code (MCP)</sub>`, 2900),
    ev('noah', commentBody({ planId: 'add-webhook-retries', version: v(W1), anchor: at(W1, 'forever'), text: 'Unbounded retries will hammer a dead endpoint for days. Cap the attempts, back off exponentially, then park it somewhere we can see.', thread: t1, via: 'Lake review' }), 2860),
    ev('noah', commentBody({ planId: 'add-webhook-retries', version: v(W1), anchor: at(W1, 'Store the full payload'), text: 'What stops a retry from charging twice? We already have an idempotency key on deliveries, use it.', thread: t2, via: 'Lake review' }), 2855),
    ev('ava', commentBody({ planId: 'add-webhook-retries', version: v(W1), anchor: at(W1, 'Store the full payload'), text: 'Resending the stored bytes "as is" means resending an old signature. Who signs the retry?', thread: t3, via: 'Lake review' }), 2840),
    ev('noah', verdictBody({ action: 'reject', planId: 'add-webhook-retries', version: v(W1), text: 'Right problem. Needs a bound on retries and an answer on double charges before we build.', via: 'Lake review' }), 2830),
    ev('maya', replyBody({ planId: 'add-webhook-retries', thread: t1, text: 'Agreed. 6 attempts over ~2h, then dead-letter with an email to the account owner.', via: 'Claude Code (MCP)' }), 1700),
    ev('maya', `**Revised plan \`add-webhook-retries\` → v${v(W2).slice(0, 8)}.** Earlier approvals no longer apply.\n\nBounded backoff, dead-letter state, idempotency key on every attempt.\n<sub>via lake-gate · Claude Code (MCP)</sub>\n${encodeMarker('resolve', { p: 'add-webhook-retries', t: t1, r: true })}\n${encodeMarker('resolve', { p: 'add-webhook-retries', t: t2, r: true })}`, 1690),
    ev('ava', commentBody({ planId: 'add-webhook-retries', version: v(W2), anchor: at(W2, 'Store the full payload'), text: 'Still replaying the stored signature. If we rotate the key mid-retry, customers get a payload they must reject. Re-sign every attempt with the current key, and refuse when it has expired.', thread: t4, via: 'Lake review' }), 1500),
    ev('ava', verdictBody({ action: 'reject', planId: 'add-webhook-retries', version: v(W2), text: 'Blocking on signing only. The rest reads well.', via: 'Lake review' }), 1495),
    ev('maya', replyBody({ planId: 'add-webhook-retries', thread: t3, text: 'Covered by step 3 in v3: we re-sign every attempt.', via: 'Lake review' }), 400),
    ev('maya', `**Revised plan \`add-webhook-retries\` → v${v(W3).slice(0, 8)}.** Earlier approvals no longer apply.\n\nRe-sign on every attempt, refuse expired keys, jitter, batched backfill, metrics.\n<sub>via lake-gate · Claude Code (MCP)</sub>\n${encodeMarker('resolve', { p: 'add-webhook-retries', t: t3, r: true })}\n${encodeMarker('resolve', { p: 'add-webhook-retries', t: t4, r: true })}`, 395),
    { id: 'd-native-review', source: 'review', state: 'APPROVED', login: 'leo', type: 'User', association: 'MEMBER', body: 'Backoff numbers and the batched backfill look right.', createdAt: ago(130), commitId: 'w3' },
    ev('ava', commentBody({ planId: 'add-webhook-retries', version: v(W3), anchor: at(W3, 're-sign every attempt'), text: 'Nice. Small one: log the key id on each re-sign so we can trace rotations.', thread: t5, via: 'Claude Code (MCP)' }), 95),
    ev('maya', replyBody({ planId: 'add-webhook-retries', thread: t5, text: 'Will do, it fits in step 6 with the metrics.', via: 'Lake review' }), 60),
    { id: 'd-line-1', source: 'line', login: 'leo', type: 'User', association: 'MEMBER', body: 'Can we tag these with the endpoint host? Makes the noisy-customer view trivial.', createdAt: ago(125),
      path: '.lake/plans/add-webhook-retries.md', line: at(W3, 'webhook.retry').start + offsetOf(W3), commitId: 'w3', inReplyTo: null },
  );
}
function v(text) { return versionsFromSnapshots([{ text }], 'x')[0].digest; }
function offsetOf(text) { return text.match(/^---\n[\s\S]*?\n---\n?/)[0].split('\n').length - 1; }

// ---------- 2. CSV exports: changes requested ----------
const C1 = file('safer-csv-exports', 'Safer CSV exports', 'sam', `# Safer CSV exports

Large accounts time out when they export transactions, and the export includes card fingerprints it shouldn't.

## Steps
1. Load all matching rows into memory, then write the CSV in one pass.
2. Drop \`card_fingerprint\` and \`ip_address\` from the export columns.
3. Email a signed download link that expires after 24 hours.
4. Add a test with a 10k-row account.
`);
const csvEvents = [
  ev('maya', commentBody({ planId: 'safer-csv-exports', version: v(C1), anchor: at(C1, 'Load all matching rows'), text: 'Our biggest account has ~4M transactions. Stream rows from a cursor straight into the file instead.', thread: 'c1stream', via: 'Lake review' }), 210),
  ev('maya', verdictBody({ action: 'reject', planId: 'safer-csv-exports', version: v(C1), text: 'Memory is the blocker. Column removal and expiring links are great.', via: 'Lake review' }), 205),
  ev('sam', replyBody({ planId: 'safer-csv-exports', thread: 'c1stream', text: 'Makes sense, rewriting step 1 now.', via: 'Lake review' }), 180),
];

// ---------- 3. Cursor pagination: approved, merged ----------
const P1 = file('cursor-pagination', 'Cursor-based pagination for /v2/charges', 'leo', `# Cursor-based pagination for /v2/charges

Offset pagination skips and repeats rows while new charges arrive.

## Steps
1. Add an opaque cursor (created_at, id) to \`GET /v2/charges\`.
2. Keep \`offset\` working for one release and log its use.
3. Update the SDK docs.
`);
const P2 = file('cursor-pagination', 'Cursor-based pagination for /v2/charges', 'leo', `# Cursor-based pagination for /v2/charges

Offset pagination skips and repeats rows while new charges arrive.

## Steps
1. Add an opaque, signed cursor (created_at, id) to \`GET /v2/charges\`.
2. Keep \`offset\` working for one release and log its use.
3. Add a composite index on (account_id, created_at, id).
4. Update the SDK docs.
`);
const pagEvents = [
  ev('noah', commentBody({ planId: 'cursor-pagination', version: v(P1), anchor: at(P1, 'opaque cursor'), text: 'Sign the cursor, or people will start hand-crafting them.', thread: 'p1sign', via: 'Lake review' }), 3300),
  ev('leo', `**Revised plan \`cursor-pagination\`.**\n<sub>via lake-gate</sub>\n${encodeMarker('resolve', { p: 'cursor-pagination', t: 'p1sign', r: true })}`, 3200),
  ev('noah', verdictBody({ action: 'approve', planId: 'cursor-pagination', version: v(P2), text: 'Index is the right call.', via: 'Lake review' }), 3100),
  ev('maya', verdictBody({ action: 'approve', planId: 'cursor-pagination', version: v(P2), via: 'GitHub check button' }), 3050),
];

// ---------- 4. Rotate API keys: draft ----------
const K1 = file('rotate-api-keys', 'Self-serve API key rotation', 'ava', `# Self-serve API key rotation

Customers open tickets to rotate keys. Let them do it with a grace period.

## Steps
1. Allow two active keys per account, each with a label and last-used time.
2. Add \`POST /v2/keys/:id/roll\` that creates a new key and expires the old one after 24h.
3. Audit-log every create, roll and revoke.
4. Add tests for the grace period and audit entries.
`);

// ---------- 5. Usage alerts: fresh, needs you ----------
const U1 = file('usage-alerts', 'Usage alerts at 80% of plan', 'ines', `# Usage alerts at 80% of plan

Customers are surprised by overage charges. Warn them before they hit their limit.

## Steps
1. Add a nightly job that compares month-to-date usage with each account's plan limit.
2. Send one email at 80% and one at 100%, at most once per month each.
3. Add an "Alerts" toggle to account settings, on by default.
4. Fix copy in the overage email.
`);
const usageEvents = [
  ev('ines', `**Plan ready for review:** Usage alerts at 80% of plan\n@noah @leo\n\nWritten with Cursor. I'm not sure about the nightly job, happy to be told it's wrong.\n<sub>via lake-gate · Cursor (MCP)</sub>`, 48),
  ev('leo', commentBody({ planId: 'usage-alerts', version: v(U1), anchor: at(U1, 'nightly job'), text: 'Nightly is fine to start. We already have hourly usage rollups if we want faster alerts later.', thread: 'u1night', via: 'Lake review' }), 22),
];

const PRS = [
  { number: 412, title: 'Webhook retries', user: 'maya', draft: false, state: 'open', branch: 'maya/webhook-retries', reviewers: ['noah', 'ava'], versions: [[W1, 'w1', 2920, 'maya'], [W2, 'w2', 1695, 'maya'], [W3, 'w3', 398, 'maya']], events: webhookEvents },
  { number: 418, title: 'Usage alerts', user: 'ines', draft: false, state: 'open', branch: 'ines/usage-alerts', reviewers: ['noah', 'leo'], versions: [[U1, 'u1', 50, 'ines']], events: usageEvents },
  { number: 409, title: 'Safer CSV exports', user: 'sam', draft: false, state: 'open', branch: 'sam/csv-exports', reviewers: ['maya'], versions: [[C1, 'c1', 260, 'sam']], events: csvEvents },
  { number: 415, title: 'API key rotation', user: 'ava', draft: true, state: 'open', branch: 'ava/key-rotation', reviewers: [], versions: [[K1, 'k1', 75, 'ava']], events: [] },
  { number: 397, title: 'Cursor pagination', user: 'leo', draft: false, state: 'closed', merged: true, branch: 'leo/cursor-pagination', reviewers: [], versions: [[P1, 'p1', 3400, 'leo'], [P2, 'p2', 3210, 'leo']], events: pagEvents },
];

// Demo state is in memory; actions append events exactly as they would be posted to GitHub.
const extra = new Map();
export function demoPost(prNumber, body) {
  const e = { id: `local${Date.now()}${Math.random().toString(36).slice(2, 6)}`, source: 'comment', login: VIEWER, type: 'User', association: 'MEMBER', body, createdAt: new Date().toISOString() };
  if (!extra.has(prNumber)) extra.set(prNumber, []);
  extra.get(prNumber).push(e);
  return e;
}
export function demoReset() { extra.clear(); }

export function demoWorkspace() {
  const plans = [];
  for (const p of PRS) {
    const snaps = p.versions.map(([text, sha, min, author]) => ({ text, sha, at: ago(min), author }));
    const versions = versionsFromSnapshots(snaps, 'x');
    const digestAt = {}; p.versions.forEach(([text, sha]) => { digestAt[sha] = v(text); });
    const plan = versions[versions.length - 1];
    const pr = { number: p.number, title: p.title, html_url: `https://github.com/${REPO}/pull/${p.number}`, draft: p.draft, state: p.state, merged_at: p.merged ? ago(3000) : null, head: { ref: p.branch } };
    plans.push(buildPlanReview({ plan, versions, events: [...p.events, ...(extra.get(p.number) || [])], prAuthor: p.user, config: CONFIG, digestAt, pr, requestedReviewers: p.reviewers }));
  }
  return { repo: REPO, plans, viewer: VIEWER, people: PEOPLE, config: CONFIG, mode: 'demo' };
}

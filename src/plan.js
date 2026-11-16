import { sha256Hex } from './sha256.js';

export const EST_START = '<!-- lake:estimate:start (generated, not part of the approved digest) -->';
export const EST_END = '<!-- lake:estimate:end -->';

export function slugify(s) {
  return String(s || 'plan').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48).replace(/-$/, '') || 'plan';
}

export function splitFrontmatter(text) {
  const t = String(text).replace(/\r\n?/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: t };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: t.slice(m[0].length) };
}

export function stripEstimate(body) {
  const s = body.indexOf(EST_START);
  if (s === -1) return body;
  const e = body.indexOf(EST_END, s);
  return e === -1 ? body.slice(0, s) : body.slice(0, s) + body.slice(e + EST_END.length);
}

// The digest covers only the human/agent-authored plan text: no frontmatter, no generated estimate,
// normalized line endings and trailing whitespace. Any other edit produces a new version.
export function normalizeBody(body) {
  return stripEstimate(body).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim() + '\n';
}

export function digestOf(body) {
  return sha256Hex(normalizeBody(body));
}

export function titleOf(body) {
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  const first = body.split('\n').find((l) => l.trim());
  return (first || 'Untitled plan').replace(/^[#>*\-\s]+/, '').slice(0, 80);
}

const SKIP_HEADINGS = /^(context|summary|overview|background|goal|goals|notes?|risks?|open questions|verification|testing plan|out of scope)\b/i;

export function extractSteps(body) {
  const lines = normalizeBody(body).split('\n');
  // 1) top-level numbered list items, with indented continuation lines
  const steps = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\s{0,3}(\d+)[.)]\s+(.+)$/);
    if (m) { cur = { title: m[2].trim(), text: m[2] }; steps.push(cur); continue; }
    if (cur && /^\s{2,}\S/.test(l)) { cur.text += '\n' + l.trim(); continue; }
    if (cur && /^\s*$/.test(l)) continue;
    cur = null;
  }
  if (steps.length) return steps;
  // 2) ## / ### headings that are not context sections
  let sec = null;
  for (const l of lines) {
    const m = l.match(/^#{2,4}\s+(.+)$/);
    if (m) { sec = SKIP_HEADINGS.test(m[1].replace(/^(step\s*)?\d+[.:)]?\s*/i, '')) ? null : { title: m[1].trim(), text: m[1] }; if (sec) steps.push(sec); continue; }
    if (sec) sec.text += '\n' + l;
  }
  if (steps.length) return steps;
  // 3) top-level bullets
  for (const l of lines) { const m = l.match(/^[-*]\s+(.+)$/); if (m) steps.push({ title: m[1].trim(), text: m[1] }); }
  if (steps.length) return steps;
  return [{ title: titleOf(body), text: body }];
}

export function renderPlanFile({ id, title, author, source, created, body, estimateMd }) {
  const fm = ['---', `id: ${id}`, `title: "${String(title).replace(/"/g, "'")}"`];
  if (author) fm.push(`author: ${author}`);
  if (source) fm.push(`source: ${source}`);
  if (created) fm.push(`created: ${created}`);
  fm.push('---', '');
  const clean = stripEstimate(body).replace(/\s+$/, '');
  return fm.join('\n') + clean + '\n\n' + EST_START + '\n' + estimateMd.trim() + '\n' + EST_END + '\n';
}

export function readPlanText(text, fallbackId) {
  const { meta, body } = splitFrontmatter(text);
  const digest = digestOf(body);
  return { id: meta.id || fallbackId, title: meta.title || titleOf(body), meta, body, digest, short: digest.slice(0, 8) };
}

// Text handed to the shared estimator: a blank line after headings, so a list right under a "# Title"
// line is read as steps (the estimator otherwise sees a one-item list there as part of the heading block).
export const forEstimator = (body) => normalizeBody(body).replace(/^(#{1,6}\s.*)\n(?=\S)/gm, '$1\n\n');

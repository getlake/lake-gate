// Small markdown renderer that keeps source line ranges on every block and list item,
// so comments can be anchored to lines and survive re-rendering. No dependencies.
import { stripEstimate } from './core/plan.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

// Returns [{type, start, end, html, text, level?, items?}] with 1-based line numbers of the plan body.
export function parseBlocks(body) {
  const lines = stripEstimate(String(body)).split('\n');
  const blocks = []; let i = 0;
  const N = lines.length;
  while (i < N) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const s = i + 1;
    let m;
    if ((m = l.match(/^```(\w*)/))) {
      const buf = []; i++;
      while (i < N && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', start: s, end: Math.min(i, N), lang: m[1], text: buf.join('\n'), html: `<pre><code>${esc(buf.join('\n'))}</code></pre>` });
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { blocks.push({ type: 'heading', level: m[1].length, start: s, end: s, text: m[2], html: inline(m[2]) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { blocks.push({ type: 'hr', start: s, end: s, html: '<hr>' }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < N && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]); const bodyRows = rows.slice(1).filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      blocks.push({ type: 'table', start: s, end: i, text: rows.join('\n'), html: `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` });
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < N && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', start: s, end: i, text: buf.join('\n'), html: `<blockquote>${inline(buf.join(' '))}</blockquote>` });
      continue;
    }
    if ((m = l.match(LIST)) && m[1].length <= 3) {
      const ordered = /\d/.test(m[2]); const items = [];
      while (i < N) {
        const lm = lines[i].match(LIST);
        if (lm && lm[1].length <= 3) { items.push({ start: i + 1, end: i + 1, num: parseInt(lm[2], 10), text: lm[3], sub: [] }); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          const it = items[items.length - 1]; const sub = lines[i].trim();
          const sm = sub.match(/^([-*+]|\d+[.)])\s+(.*)$/);
          if (sm) it.sub.push(sm[2]); else it.text += ' ' + sub;
          it.end = i + 1; i++; continue;
        }
        if (!lines[i].trim() && i + 1 < N && (LIST.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1])) && items.length) { i++; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, start: s, end: items[items.length - 1].end, items, text: items.map((x) => x.text).join('\n') });
      continue;
    }
    const buf = [];
    while (i < N && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*\|)/.test(lines[i]) && !(LIST.test(lines[i]) && buf.length)) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    blocks.push({ type: 'p', start: s, end: s + buf.length - 1, text: buf.join(' '), html: `<p>${inline(buf.join(' '))}</p>` });
  }
  return blocks;
}

// Section outline (## headings) with line ranges.
export function outline(blocks) {
  const out = [];
  for (const b of blocks) if (b.type === 'heading' && b.level <= 3) out.push({ title: b.text, start: b.start, level: b.level });
  out.forEach((o, k) => { o.end = out[k + 1] ? out[k + 1].start - 1 : Infinity; });
  return out;
}

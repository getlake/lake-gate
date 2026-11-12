import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';

export const ACTION_REF = 'lakeresearch/lake-gate@v0';
const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const HOOK_COMMAND = 'if [ -x "$CLAUDE_PROJECT_DIR/node_modules/.bin/lake-gate" ]; then exec "$CLAUDE_PROJECT_DIR/node_modules/.bin/lake-gate" hook claude; elif command -v lake-gate >/dev/null 2>&1; then exec lake-gate hook claude; else exec npx -y lake-gate@0 hook claude; fi';
const MATCHER = 'ExitPlanMode|Edit|Write|MultiEdit|NotebookEdit|Bash';

export function mergeClaudeSettings(settings) {
  const s = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  s.hooks = s.hooks || {};
  const list = (s.hooks.PreToolUse = s.hooks.PreToolUse || []);
  const already = list.some((g) => (g.hooks || []).some((h) => String(h.command || '').includes('lake-gate')));
  if (!already) list.push({ matcher: MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30, onFailure: 'block' }] });
  return { settings: s, changed: !already };
}

export function init(root, { actionRef = ACTION_REF, force = false } = {}) {
  const done = [];
  const write = (rel, content, overwrite = force) => {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && !overwrite) { done.push(`kept   ${rel} (exists)`); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    done.push(`wrote  ${rel}`);
  };
  const { models, tokens, tierFor, ...short } = DEFAULT_CONFIG;
  write('.lake/config.json', JSON.stringify({ ...short, models }, null, 2) + '\n');
  write('.lake/plans/README.md', fs.readFileSync(path.join(TEMPLATES, 'plans-README.md'), 'utf8'));
  write('.github/workflows/lake-gate.yml', fs.readFileSync(path.join(TEMPLATES, 'lake-gate.yml'), 'utf8').replace('__ACTION_REF__', actionRef));

  const sp = path.join(root, '.claude', 'settings.json');
  let current = {};
  if (fs.existsSync(sp)) { try { current = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { throw new Error('.claude/settings.json is not valid JSON; fix it and run init again.'); } }
  const { settings, changed } = mergeClaudeSettings(current);
  if (changed) { fs.mkdirSync(path.dirname(sp), { recursive: true }); fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n'); done.push('merged .claude/settings.json (PreToolUse hook)'); }
  else done.push('kept   .claude/settings.json (hook already present)');
  return done;
}

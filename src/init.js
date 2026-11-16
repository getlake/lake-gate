import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';

export const ACTION_REF = 'getlake/lake-gate@v0';
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

export const MCP_SERVER = { command: 'npx', args: ['-y', 'lake-gate@0', 'mcp'] };
export function mergeMcpConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? structuredClone(cfg) : {};
  c.mcpServers = c.mcpServers || {};
  if (c.mcpServers['lake-gate']) return { config: c, changed: false };
  c.mcpServers['lake-gate'] = MCP_SERVER;
  return { config: c, changed: true };
}

export function init(root, { actionRef = ACTION_REF, force = false, trial = false } = {}) {
  const done = [];
  const write = (rel, content, overwrite = force) => {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && !overwrite) { done.push(`kept   ${rel} (exists)`); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    done.push(`wrote  ${rel}`);
  };
  // Short config: sensible defaults live in the code; only what a team usually changes is written.
  const d = DEFAULT_CONFIG;
  write('.lake/config.json', JSON.stringify({ requiredApprovals: d.requiredApprovals, autoApprove: d.autoApprove, budget: { approverAbove: null, approvers: [] }, ...(trial ? { try: true } : {}) }, null, 2) + '\n');
  write('.lake/plans/README.md', fs.readFileSync(path.join(TEMPLATES, 'plans-README.md'), 'utf8'));
  write('.github/workflows/lake-gate.yml', fs.readFileSync(path.join(TEMPLATES, 'lake-gate.yml'), 'utf8').replace('__ACTION_REF__', actionRef));

  const sp = path.join(root, '.claude', 'settings.json');
  let current = {};
  if (fs.existsSync(sp)) { try { current = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { throw new Error('.claude/settings.json is not valid JSON; fix it and run init again.'); } }
  const { settings, changed } = mergeClaudeSettings(current);
  if (changed) { fs.mkdirSync(path.dirname(sp), { recursive: true }); fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n'); done.push('merged .claude/settings.json (PreToolUse hook)'); }
  else done.push('kept   .claude/settings.json (hook already present)');

  // MCP server registration: Claude Code reads .mcp.json, Cursor reads .cursor/mcp.json
  for (const rel of ['.mcp.json', path.join('.cursor', 'mcp.json')]) {
    const p = path.join(root, rel);
    let cur = {};
    if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { done.push(`kept   ${rel} (not valid JSON, add lake-gate by hand)`); continue; } }
    const { config, changed: ch } = mergeMcpConfig(cur);
    if (ch) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n'); done.push(`merged ${rel} (lake-gate MCP server)`); }
    else done.push(`kept   ${rel} (lake-gate MCP already present)`);
  }
  return done;
}

// Undo init: remove the hook, the MCP entries and the workflow. Plans and config in .lake/ stay (they're your history).
export function uninstall(root) {
  const done = [];
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const sp = path.join(root, '.claude', 'settings.json');
  const s = fs.existsSync(sp) && readJson(sp);
  if (s?.hooks?.PreToolUse) {
    const before = JSON.stringify(s.hooks.PreToolUse);
    s.hooks.PreToolUse = s.hooks.PreToolUse.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes('lake-gate')) })).filter((g) => g.hooks.length);
    if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse;
    if (!Object.keys(s.hooks).length) delete s.hooks;
    if (JSON.stringify(s.hooks?.PreToolUse) !== before) {
      if (Object.keys(s).length) fs.writeFileSync(sp, JSON.stringify(s, null, 2) + '\n'); else fs.rmSync(sp);
      done.push('removed the lake-gate hook from .claude/settings.json');
    }
  }
  for (const rel of ['.mcp.json', path.join('.cursor', 'mcp.json')]) {
    const p = path.join(root, rel); const c = fs.existsSync(p) && readJson(p);
    if (!c?.mcpServers?.['lake-gate']) continue;
    delete c.mcpServers['lake-gate'];
    if (!Object.keys(c.mcpServers).length) delete c.mcpServers;
    if (Object.keys(c).length) fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n'); else fs.rmSync(p);
    done.push(`removed the lake-gate MCP server from ${rel}`);
  }
  const wf = path.join(root, '.github', 'workflows', 'lake-gate.yml');
  if (fs.existsSync(wf)) { fs.rmSync(wf); done.push('removed .github/workflows/lake-gate.yml'); }
  for (const d of ['.cursor', path.join('.github', 'workflows'), '.github', '.claude']) { try { fs.rmdirSync(path.join(root, d)); } catch { /* not empty or missing */ } }
  if (!done.length) done.push('Nothing to remove: lake-gate is not set up here.');
  return done;
}

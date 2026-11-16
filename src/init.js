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

// Upgrades an existing lake-gate workflow in place (keeps your edits): adds the push trigger that re-checks
// open PRs when .lake/config.json changes on the base branch (0.2.3+).
export const PUSH_TRIGGER = "  push: # a policy change re-checks open PRs into this branch\n    paths: ['.lake/config.json']\n";
export function upgradeWorkflow(text) {
  if (!/lake-gate/.test(text)) return { changed: false, manual: 'it does not look like the lake-gate workflow' };
  const onBlock = text.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m);
  if (!onBlock) return { changed: false, manual: "add `push: { paths: ['.lake/config.json'] }` under `on:`" };
  if (/^\s+push:/m.test(onBlock[1])) return { changed: false };
  const end = onBlock.index + onBlock[0].length;
  const body = onBlock[0].replace(/\s*$/, '\n');
  return { changed: true, text: text.slice(0, onBlock.index) + body + PUSH_TRIGGER + text.slice(end).replace(/^\n*/, ''), what: 'added the push trigger: policy changes on the base branch re-check open PRs' };
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
  // The team's policy is never overwritten, not even with --force: budget and approver rules must not vanish.
  const d = DEFAULT_CONFIG;
  write('.lake/config.json', JSON.stringify({ requiredApprovals: d.requiredApprovals, autoApprove: d.autoApprove, budget: { approverAbove: null, approvers: [] }, ...(trial ? { try: true } : {}) }, null, 2) + '\n', false);
  if (done.at(-1).startsWith('kept')) done[done.length - 1] = 'kept   .lake/config.json (your policy; init never changes it, even with --force)';
  write('.lake/plans/README.md', fs.readFileSync(path.join(TEMPLATES, 'plans-README.md'), 'utf8'));
  const wfRel = '.github/workflows/lake-gate.yml';
  const wfPath = path.join(root, wfRel);
  const template = fs.readFileSync(path.join(TEMPLATES, 'lake-gate.yml'), 'utf8').replace('__ACTION_REF__', actionRef);
  if (fs.existsSync(wfPath) && !force) {
    const r = upgradeWorkflow(fs.readFileSync(wfPath, 'utf8'));
    if (r.changed) { fs.writeFileSync(wfPath, r.text); done.push(`updated ${wfRel} (${r.what})`); }
    else done.push(r.manual ? `kept   ${wfRel} (could not update it automatically: ${r.manual})` : `kept   ${wfRel} (up to date)`);
  } else write(wfRel, template);

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

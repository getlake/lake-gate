// Browser-safe part of the config (no fs). config.js adds loadConfig for Node.
export const DEFAULT_CONFIG = {
  requiredApprovals: 1,
  allowedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  ignoreLogins: [],
  requirePlan: 'warn', // PR check when code changes without a plan: "off" | "warn" | "fail"
  gateWithoutPlan: false, // true: block agent edits until there is a plan at all (strict teams)
  try: false, // trial mode (`init --try`): `lake-gate approve` self-approves locally; never counts on the PR
  localGate: 'block', // Claude Code hook: "block" | "ask" | "off"
  gatedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
  readOnlyBash: [
    '^\\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|tree|file|stat|which|echo|env|date|du|df)(\\s|$)',
    '^\\s*git\\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|fetch)(\\s|$)',
    '^\\s*(npx\\s+(-y\\s+)?)?lake-gate(@\\S+)?\\s+(status|estimate|check|sync|plan|help)(\\s|$)',
  ],
  nativeReviews: true, // GitHub "Review changes → Approve / Request changes" counts for the plan version at the reviewed commit
  reviewUrl: 'https://getlake.dev/lake-gate/app/', // Lake review UI linked from the PR summary ("" to hide the buttons)
  checkButtons: false, // experimental: Approve / Request changes buttons on a GitHub check run (needs checks: write)
  autoApprove: { mode: 'on', maxUsd: 1.5, maxSteps: 3, maxComplexity: 'low', maxCodeLines: 150 }, // tiny plans with a small diff pass without a human. mode: "off" | "shadow" | "on"
  // Budget approval: above approverAbove (USD, upper estimate or the plan's "Budget cap") one of approvers
  // must approve the exact version too. List GitHub logins, e.g. ["alice", "bob"]. "@org/team" needs a token with
  // read:org, which the default Action token doesn't have (lake-gate then warns and lets repo admins approve).
  budget: { approverAbove: null, approvers: [], suggestAbove: 0, suggestCapAbove: 10 },
  catalog: {}, // extra models in lake-meter's prices.json shape, e.g. { "my-model": { "label": "My model", "tier": "standard", "input": 1, "cacheRead": 0.1, "output": 5 } }
  provider: 'anthropic', // model family for Lake's picks: "anthropic" | "openai". Prices: lake-meter's table (meter-core.js)
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
export function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

// Config files are hand-edited, so accept // and /* */ comments and trailing commas (JSONC).
export function stripJsonc(text) {
  let out = ''; let i = 0; let inStr = false;
  const s = String(text).replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i];
    if (inStr) { out += c; if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && s[i + 1] === '*') { out += '  '; i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  // trailing commas before } or ] (outside strings: strings were copied verbatim, so check by re-scanning)
  let res = ''; inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) { res += c; if (c === '\\') { res += out[j + 1] ?? ''; j++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === ',') { let k = j + 1; while (k < out.length && /\s/.test(out[k])) k++; if (out[k] === '}' || out[k] === ']') { res += ' '; continue; } }
    res += c;
  }
  return res;
}

export class ConfigError extends Error {}
// Throws ConfigError with the file, line and column when the JSON can't be read even leniently.
export function parseConfig(text, file = '.lake/config.json') {
  if (!text || !String(text).trim()) return DEFAULT_CONFIG;
  const clean = stripJsonc(text);
  let data;
  try { data = JSON.parse(clean); } catch (e) {
    const m = String(e.message).match(/position (\d+)/); const pos = m ? Number(m[1]) : null;
    const where = pos == null ? '' : (() => { const before = clean.slice(0, pos).split('\n'); return ` (line ${before.length}, column ${before.at(-1).length + 1})`; })();
    throw new ConfigError(`${file} is not valid JSON${where}: ${String(e.message).replace(/ in JSON at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)$/, '')}`);
  }
  if (!isObj(data)) throw new ConfigError(`${file} must contain a JSON object ({ ... }).`);
  return merge(DEFAULT_CONFIG, data);
}
// Never throws. A broken file never loosens the policy: callers first look for the last valid version
// (git history); if there is none, this strict fallback applies: defaults with auto-approve OFF, marked
// policyBroken so the PR check fails closed, and configError says what to fix (file, line, column).
export const STRICT_FALLBACK = { ...DEFAULT_CONFIG, autoApprove: { ...DEFAULT_CONFIG.autoApprove, mode: 'off' } };
export function safeParseConfig(text, file) {
  try { return parseConfig(text, file); } catch (e) { if (!(e instanceof ConfigError)) throw e; return { ...STRICT_FALLBACK, configError: e.message, policyBroken: true }; }
}
// A broken file plus the last valid version of it: keep that policy and say so.
export function withLastValid(broken, lastText, from) {
  if (!broken.configError || lastText == null) return broken;
  try { return { ...parseConfig(lastText), configError: broken.configError, policyFrom: from }; } catch { return broken; }
}
// One line for humans (summary, hook, status, MCP).
export function configWarning(c) {
  if (!c?.configError) return null;
  return c.policyFrom ? `${c.configError}. lake-gate keeps the last valid policy (${c.policyFrom}) until it's fixed.`
    : `${c.configError}. No earlier valid version found, so lake-gate fails closed: nothing auto-approves and the PR check stays red until it's fixed.`;
}

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
  reviewUrl: 'https://getlake.github.io/lake-gate/app/', // Lake review UI linked from the PR summary ("" to hide the buttons)
  checkButtons: false, // experimental: Approve / Request changes buttons on a GitHub check run (needs checks: write)
  autoApprove: { mode: 'on', maxUsd: 1.5, maxSteps: 3, maxComplexity: 'low' }, // tiny plans pass without a human. mode: "off" | "shadow" | "on"
  // Budget approval: above approverAbove (USD, upper estimate or the plan's "Budget cap") one of approvers
  // (GitHub logins or "@org/team") must approve the exact version too. Off until you set both.
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

export function parseConfig(text) {
  if (!text) return DEFAULT_CONFIG;
  return merge(DEFAULT_CONFIG, JSON.parse(text));
}

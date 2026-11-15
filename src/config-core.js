// Browser-safe part of the config (no fs). config.js adds loadConfig for Node.
// Prices are public list prices per million tokens, copied from
// https://docs.anthropic.com/en/docs/about-claude/pricing on 2026-11-12.
// They are assumptions for a forecast, not a quote. Edit .lake/config.json to change them.
export const DEFAULT_CONFIG = {
  requiredApprovals: 1,
  allowedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  ignoreLogins: [],
  requirePlan: 'warn', // PR check when code changes without a plan: "off" | "warn" | "fail"
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
  autoApprove: { mode: 'shadow', maxUsd: 1.5, maxSteps: 3, maxComplexity: 'low' }, // mode: "off" | "shadow" | "on"
  cacheHitShare: 0.7,
  pricesAsOf: '2026-11-12',
  models: {
    fast: { name: 'Claude Haiku 5.5', inputPerMTok: 0.5, cacheReadPerMTok: 0.05, outputPerMTok: 2.5 },
    balanced: { name: 'Claude Sonnet 5.5', inputPerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 10 },
    frontier: { name: 'Claude Opus 5.5', inputPerMTok: 4, cacheReadPerMTok: 0.2, outputPerMTok: 20 },
  },
  tierFor: { low: 'fast', medium: 'balanced', high: 'frontier' },
  // Rough agentic token bands per step (input includes re-read context; output is generated code/text).
  tokens: {
    low: { in: [120000, 400000], out: [4000, 15000] },
    medium: { in: [400000, 1200000], out: [15000, 45000] },
    high: { in: [1000000, 3500000], out: [35000, 120000] },
  },
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

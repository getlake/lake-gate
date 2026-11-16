import { autoApproveVerdict } from './estimate.js';
import { budgetRule } from './models.js';

// Commands, one per line, in a PR comment or review body:
//   /lake approve <plan-id>@<digest-prefix>
//   /lake reject  <plan-id>@<digest-prefix>   (request changes; blocks until the same person approves)
//   /lake revoke  <plan-id>                    (withdraw your approval of any version)
const CMD = /^\s*\/lake\s+(approve|reject|revoke)\b[ \t]*([^\s@]+)?(?:@([0-9a-f]{7,64}))?/gim;

export function parseCommands(body) {
  const out = [];
  for (const m of String(body || '').matchAll(CMD)) out.push({ action: m[1].toLowerCase(), id: m[2] || null, digest: m[3] ? m[3].toLowerCase() : null });
  return out;
}

// events: [{ login, type: 'User'|'Bot', association, body, createdAt, source: 'comment'|'review' }]
export function evaluatePlan({ plan, estimate, events, prAuthor, config, budgetApprovers }) {
  const approvals = new Map();
  const blockers = new Map();
  const assoc = new Map();
  const notes = [];
  const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const ev of sorted) {
    for (const c of parseCommands(ev.body)) {
      if (c.id && c.id !== plan.id) continue;
      if (!c.id) { notes.push(`@${ev.login}: "/lake ${c.action}" needs a plan id, e.g. /lake ${c.action} ${plan.id}@${plan.short}`); continue; }
      const who = ev.login;
      const ineligible =
        ev.type === 'Bot' ? 'bots and agents cannot approve' :
        prAuthor && who.toLowerCase() === prAuthor.toLowerCase() ? 'the plan author cannot approve their own plan' :
        (config.ignoreLogins || []).some((x) => x.toLowerCase() === who.toLowerCase()) ? 'listed in ignoreLogins' :
        !config.allowedAssociations.includes(ev.association) ? `association ${ev.association} lacks write access` : null;
      if (c.action === 'revoke') { approvals.delete(who); continue; }
      if (ineligible) { notes.push(`ignored ${c.action} from @${who}: ${ineligible}`); continue; }
      const matches = c.digest && plan.digest.startsWith(c.digest);
      if (!matches) { notes.push(`ignored ${c.action} from @${who}: ${c.digest ? `refers to version ${c.digest.slice(0, 8)}, current is ${plan.short}` : 'missing version'} (edits invalidate approval)`); continue; }
      if (c.action === 'approve') { approvals.set(who, ev.createdAt); assoc.set(who, ev.association); blockers.delete(who); }
      else { blockers.set(who, ev.createdAt); approvals.delete(who); }
    }
  }
  const auto = estimate ? autoApproveVerdict(estimate, config) : { eligible: false, mode: 'off', reasons: [] };
  // Budget: above config.budget.approverAbove one of the budget approvers must approve this exact version too
  // (their approval also counts toward requiredApprovals).
  const rule = estimate ? budgetRule(estimate, config, budgetApprovers) : { required: false };
  const lc = (x) => String(x).toLowerCase();
  const budgetBy = rule.required ? [...approvals.keys()].filter((a) => rule.approvers.some((b) => lc(b) === lc(a)) || (rule.fallback === 'owner' && assoc.get(a) === 'OWNER')) : [];
  const budget = rule.required ? { ...rule, approvedBy: budgetBy, satisfied: budgetBy.length > 0 } : { required: false, satisfied: true };
  let state;
  if (blockers.size) state = 'changes-requested';
  else if (approvals.size >= config.requiredApprovals && budget.satisfied) state = 'approved';
  else if (approvals.size >= config.requiredApprovals) state = 'needs-budget';
  else if (auto.mode === 'on' && auto.eligible && !budget.required) state = 'auto-approved';
  else state = 'pending';
  return { id: plan.id, digest: plan.digest, short: plan.short, state, approvers: [...approvals.keys()], blockers: [...blockers.keys()], auto, notes, budget,
    needed: Math.max(0, config.requiredApprovals - approvals.size) };
}

export const isPassing = (r) => r.state === 'approved' || r.state === 'auto-approved';

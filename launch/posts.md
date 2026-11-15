# lake-gate launch posts (ready to paste, DRAFTS: nothing has been posted)

URLs already point to https://github.com/getlake/lake-gate and https://getlake.github.io/lake-gate. No founder name; the voice is "we" (the Lake team). These are drafts only; nothing has been posted.

---

## 1. Show HN

**Title** (80 char max):
Show HN: Lake-gate – coding agents wait until a teammate approves the exact plan

**URL:** https://github.com/getlake/lake-gate

**First comment:**

Hi HN. We built lake-gate, a small open-source tool for teams that use Claude Code, Cursor or Codex.

The problem: plan mode is solo. Someone on the team asks the agent for a plan, skims it, hits approve, and the agent runs. In public threads we kept seeing three things. People admit they rubber-stamp long plans. "Small" tasks skip review, and that's where the drift starts. And the plan someone OK'd in Slack isn't always the plan the agent ran. One developer told us he built his own fix: his merge script rejects any review older than the latest commit.

lake-gate makes that version-bound approval the default, with no server:

- When Claude Code leaves plan mode, a PreToolUse hook saves the plan to `.lake/plans/<id>.md` with a sha256 version, a complexity rating, a recommended model per step and a cost range.
- The same hook denies Edit/Write and non-read-only Bash until the plan's current version is approved. Reading and exploring still work.
- A teammate approves on the PR with `/lake approve <id>@<version>`. The PR author, bots and read-only users don't count.
- A GitHub Action sets a `lake/plan-approval` status. Edit the plan and the approval no longer matches, so the check goes red.
- Optional auto-approve for small, cheap plans. It ships in shadow mode.

Install is `npx lake-gate init`. It writes the hook config, a workflow and `.lake/config.json`. It has zero dependencies, no telemetry, and it's MIT.

What it isn't: a security boundary. A human can turn the local hook off, and the required GitHub check is the real gate. It also doesn't watch a run once it starts. The estimate is a keyword heuristic times list prices, not a quote.

We'd love to hear from teams. Would you keep this on after a week, or does it turn into a ritual?

---

## 2. Reddit, r/ClaudeCode (use the Showcase / "Built with Claude" flair if required; check the sidebar rules first)

**Title:**
I made Claude Code wait for a teammate's approval of the exact plan version before it edits anything (free, open source)

**Body:**

Plan mode is great when you're alone. On a team it quietly breaks. You approve your own agent's plan, small tasks skip review, and the plan someone said yes to in Slack isn't the one that actually runs.

lake-gate is a PreToolUse hook plus a GitHub Action:

1. When Claude exits plan mode, the hook saves the plan to `.lake/plans/` with a version hash. It also adds a per-step complexity rating, a recommended model (Haiku / Sonnet / Opus) and a cost range.
2. Until a teammate approves, the hook denies Edit/Write and non-read-only Bash. Claude can still read, grep and explain.
3. Your teammate comments `/lake approve add-webhook-retries@86eab4d0` on the PR. You can't approve your own plan.
4. If anyone edits the plan, the version changes and the gate closes again. The PR check (`lake/plan-approval`) goes red until the new version is approved.

Setup is `npx lake-gate init`, then make the check required. There's no server, no account and no telemetry.

Honest limits: it's a guardrail, not a security boundary. It gates the start of a run, not the run itself. The cost numbers are heuristic ranges.

Repo: https://github.com/getlake/lake-gate

What would make you keep it on, and what would make you rip it out?

---

## 3. Reddit, r/cursor (only if the sub allows tool posts; Cursor support is via the pre-run check, so lead with that honestly)

**Title:**
Pre-run plan approval for Cursor/Codex teams: plan in the repo, teammate approves the exact version, `lake-gate check` gates the run

**Body:**

Built for teams where one person's agent run can burn a day or a budget. Save the agent's plan as markdown and run `npx lake-gate plan plan.md`. It lands in `.lake/plans/` with per-step model recommendations and a cost range. A teammate approves on the PR with `/lake approve id@version`, and `npx lake-gate check` exits non-zero until that exact version is approved, so you can put it in front of any agent command. On Claude Code it's enforced by a hook; on Cursor it's a pre-run check for now. Free, MIT, no telemetry. https://github.com/getlake/lake-gate

---

## 4. X / Bluesky (thread, from the Lake account)

1/ Plan mode is solo. Shipping is a team sport.

We open-sourced lake-gate: your coding agent waits for a real yes from a teammate, for that exact version of the plan. https://github.com/getlake/lake-gate

2/ When Claude Code leaves plan mode, the plan lands in your repo with a version hash. Every step gets a complexity rating, a recommended model and a cost range.

3/ Until a teammate comments `/lake approve id@version` on the PR, the hook blocks edits. Edit one word of the plan and the approval expires.

4/ The GitHub check `lake/plan-approval` keeps unapproved plans out of main. Small, cheap plans can auto-approve (shadow mode first).

5/ `npx lake-gate init`. Zero dependencies, no server, no telemetry, MIT. Looking for a few teams of 2–10 to try it: https://getlake.github.io/lake-gate

---

## 5. LinkedIn (Lake company page, only if one exists; don't create a fake personal profile)

Your coding agent should wait for a real yes.

We just open-sourced lake-gate for teams that build with Claude Code, Cursor and Codex. The agent's plan goes into the repo with a cost estimate per step. Implementation is blocked until a teammate approves that exact version, and editing the plan resets the approval. A GitHub check keeps unapproved plans from merging.

Free, MIT, no telemetry. We're looking for a few design-partner teams: https://getlake.github.io/lake-gate

---

## 6. Listing PRs (awesome lists): one-line entry

- [lake-gate](https://github.com/getlake/lake-gate) - PreToolUse hook + GitHub Action: saves the plan to the repo with per-step model/cost estimates, blocks edits until a non-author teammate approves the exact plan version on the PR.

Candidate lists (verify each list's contribution rules first): awesome-claude-code (hooks section), awesome lists for GitHub Actions, the GitHub Marketplace listing of the Action itself.

---

## 7. Repo / package metadata

- GitHub description: Coding agents wait until a teammate approves the exact plan version. Claude Code hook + GitHub Action. No server, no telemetry.
- Topics: claude-code, claude-code-hooks, ai-agents, code-review, github-actions, plan-review, cursor, codex, developer-tools
- npm description: already in package.json.

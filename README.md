# lake-gate

**Your agent writes the plan. A teammate approves that exact version. Then the agent builds.**

lake-gate is a small, free, open-source plan gate for teams using Claude Code, Cursor or Codex. It runs in your repo and on GitHub. There is no Lake server, no account and no telemetry.

- **Plan export.** When Claude Code leaves plan mode, the plan is saved to `.lake/plans/<id>.md` with a complexity rating, a recommended model per step and a cost range.
- **Version-bound approval.** A teammate approves on the PR with `/lake approve <id>@<version>`. Edit one word of the plan and the approval no longer applies.
- **Local gate.** A Claude Code `PreToolUse` hook denies file edits and non-read-only shell commands until the active plan's current version is approved. Reading and exploring stay free.
- **PR check.** A GitHub Action sets the `lake/plan-approval` status. Make it required and unapproved plans can't merge.
- **Review app.** Rendered plans, comments on exact lines, review rounds per plan version with a diff between them, verdicts and an activity timeline. Approve or request changes in one click. Run it locally with `npx lake-gate ui`, or use the hosted static app (it talks to the GitHub API straight from your browser). [Live demo with a made-up team](https://getlake.github.io/lake-gate/app/#/demo).
- **Approve from where you already are.** The Lake review app, GitHub's own **Approve** button, or your agent chat (MCP server for Claude Code and Cursor). They all write to the same place, the PR, so there is one source of truth.
- **Auto-approve for small plans (optional).** Small, cheap, low-complexity plans can skip review. It ships in shadow mode: the PR shows "would auto-approve" and a human still decides.

## Install (about 10 minutes)

```bash
cd your-repo
npx lake-gate init          # writes .lake/, .claude/settings.json hook, .github/workflows/lake-gate.yml
npm i -D lake-gate          # optional for JS repos: faster hook than npx
git add .lake .claude .github && git commit -m "Add lake-gate" && git push
```

If the npm package is not available yet, install from GitHub first:

```bash
npm i -g github:getlake/lake-gate
# then in your repo:
lake-gate init
```

Then in GitHub: **Settings → Branches → branch protection → Require status checks → `lake/plan-approval`** (the check appears after the first PR runs).

Requirements: Node 18.17+, git, a GitHub repo. macOS/Linux shells for the hook (Windows: use WSL for now).

## The flow

1. **Plan.** In Claude Code, use plan mode as usual. When the plan is accepted, the hook saves it to `.lake/plans/add-webhook-retries.md` and tells you its version and estimate. Using Cursor or Codex? Save the plan as markdown and run `npx lake-gate plan plan.md`.
2. **Open a PR with the plan first** (a draft PR is fine). The Action posts one summary comment with the exact approve line.
3. **A teammate approves** with a PR comment or review: `/lake approve add-webhook-retries@86eab4d0`. The PR author and bots can't approve. Read-only users can't approve.
4. **Sync and build.** `npx lake-gate sync` pulls approvals into your local checkout (uses `GITHUB_TOKEN` or `gh auth token`). The agent can now edit. The code lands in the same PR and the check is green.
5. **Plan changes?** Edit the plan file. The version changes, the gate closes again and the PR check turns red until someone approves the new version.

Commands on the PR, one per line:

| Comment | Effect |
|---|---|
| `/lake approve <id>@<version>` | Approve this exact version |
| `/lake reject <id>@<version>` | Request changes. Blocks until the same person approves |
| `/lake revoke <id>` | Withdraw your approval |

## Reviewing: the app, GitHub, and your agent

Everything is stored on the PR as normal comments and reviews. There's no database and nothing new to host. The review app, the Action, `lake-gate sync` and the MCP server all read the same comments.

**Review app.** `npx lake-gate ui` opens `http://127.0.0.1:4848`. It uses your `gh` login (or `GITHUB_TOKEN`) through a small local proxy: the token never reaches the page, the proxy only talks to this repo, and it only writes PR comments. It also shows plans you haven't pushed yet, as drafts, with their local history. The hosted copy at `getlake.github.io/lake-gate/app/` is the same static app. It asks for a fine-grained token (Pull requests: read & write, Contents: read) and keeps it in your browser.

- Select text in a plan, or click a line, to comment on it (`c`). Threads reply and resolve.
- Each pushed version of the plan is a **round**. Comments stay attached to the round they were made on, and move forward to the current text when the quoted line still exists.
- **Changes** shows the diff between any two rounds. **Activity** is the timeline: who commented, approved or requested changes, on which version, and from where.
- `a` approve, `r` request changes, `j`/`k` next/previous thread, `?` for all shortcuts.

**GitHub.** Three ways, all counted by the same policy:

1. **GitHub's native review.** Approve or Request changes on the PR with GitHub's own buttons. It counts for the plan version at the reviewed commit (turn it off with `nativeReviews: false`). Line comments on the plan file show up as threads in the app.
2. **Buttons in the summary comment.** *Approve*, *Request changes* and *Open review* open the review app on the right plan with the approve sheet ready (`reviewUrl`, default: the hosted app).
3. **Check-run buttons (experimental, off by default).** With `checkButtons: true`, the Action adds a "Lake plan review" check with Approve / Request changes buttons on the Checks tab. A click from someone with write access is relayed as a bot comment that names them. This has not been tested against GitHub's live API yet. It needs `checks: write` and the `check_run` trigger, which `init` adds.

The typed `/lake approve <id>@<version>` line still works everywhere.

**Your agent (MCP).** `init` registers `npx lake-gate mcp` in `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor). Tools:

| Tool | What it does |
|---|---|
| `lake_request_review` | Save the plan (with an estimate), optionally commit and push only the plan file, and return the review link |
| `lake_review_status` | Status, rounds, verdicts and open threads with their line numbers. `wait_seconds` (up to 240) waits for new feedback |
| `lake_submit_revision` | Save a revised plan and mark the threads it addresses as resolved |
| `lake_reply`, `lake_comment` | Reply to a thread, or comment on a line range |
| `lake_approve`, `lake_request_changes` | A reviewer approves from their own agent chat. They need the exact version and refuse a stale one. The comment is labelled "via Claude Code (MCP)" |

The PR author can't approve their own plan from any surface. An approval from an agent chat is posted under the human's GitHub account, so only use it when that person asked for it.

**How it's stored.** Comments from the app and the MCP server are PR comments with a small hidden marker, for example `<!-- lake:c {"p":"plan-id","v":"86eab4d0","t":"t1","a":{"s":12,"e":14,"q":"quoted text"}} -->`. Verdicts are the usual `/lake approve|reject` lines, so older versions of lake-gate and humans read them the same way.

## What the estimate looks like

```
| # | Step                                         | Complexity | Recommended model | Est. cost   |
| 1 | Add a bounded retry queue with backoff       | medium     | Claude Sonnet 5.5 | $0.42–$1.25 |
| 2 | Database migration: retry_count column       | high       | Claude Opus 5.5   | $2.04–$7.09 |
| 3 | Fix typo in README                           | low        | Claude Haiku 5.5  | $0.032–$0.11|
```

It's a rough heuristic: keywords plus token bands per complexity, multiplied by public API list prices (as of 2026-11-12, cache hits assumed). It isn't a quote or a spending cap. On a subscription plan you spend quota, not these dollars. Prices, models and bands are all in `.lake/config.json`.

## CLI

```
lake-gate init [--action-ref owner/repo@ref] [--force]
lake-gate plan <file.md|-> [--id name]   save a plan with an estimate and make it active
lake-gate estimate <file.md|->           print the estimate only
lake-gate status                         plans, versions, approval state
lake-gate sync [--pr N]                  pull approvals from the PR
lake-gate check [--plan id]              exit 0 only if the active plan's current version is approved
lake-gate use <id>                       switch the active plan (the hook blocks agents from doing this)
lake-gate ui [--port 4848] [--no-open]   the review app on localhost
lake-gate mcp                            MCP server (stdio) for Claude Code / Cursor
lake-gate hook claude                    the Claude Code PreToolUse hook (stdin JSON)
```

`check` is the pre-run gate for anything that isn't Claude Code, e.g. `npx lake-gate check && codex exec "implement .lake/plans/x.md"`.

## Configuration: `.lake/config.json`

| Key | Default | Meaning |
|---|---|---|
| `requiredApprovals` | `1` | Distinct non-author approvals needed |
| `allowedAssociations` | `OWNER, MEMBER, COLLABORATOR` | Who may approve |
| `ignoreLogins` | `[]` | Logins that never count (e.g. a shared agent account) |
| `requirePlan` | `"warn"` | PR changes code without a plan: `off`, `warn`, `fail` |
| `localGate` | `"block"` | Hook behaviour: `block` (deny), `ask` (Claude Code prompts you), `off` |
| `readOnlyBash` | git status/log/diff, ls, cat, rg... | Bash commands allowed before approval (regexes; chained commands are not) |
| `autoApprove` | `{mode:"shadow", maxUsd:1.5, maxSteps:3, maxComplexity:"low"}` | `off`, `shadow`, or `on` |
| `nativeReviews` | `true` | GitHub's own Approve / Request changes count for the plan version at the reviewed commit |
| `reviewUrl` | hosted review app | Where the summary comment's buttons point. `""` hides them |
| `checkButtons` | `false` | Experimental check-run Approve / Request changes buttons |
| `models`, `cacheHitShare` | Haiku / Sonnet / Opus 5.5 list prices | Edit to match your stack |

The PR check reads the config from the **base branch**, so a PR can't loosen its own policy.

## What it does not do (read this)

- **It is a guardrail, not a security boundary.** The local hook stops an agent from drifting into implementation. A human can turn it off (`LAKE_GATE=off`, editing settings). The real enforcement point is the required GitHub status.
- **A malicious insider can bypass the PR check** by editing the workflow in a `pull_request` run. Protect `.github/` and `.lake/config.json` with CODEOWNERS if that matters to you. Comment events always run the workflow from the default branch.
- **Approval doesn't stop a run that goes wrong after it starts.** lake-gate gates the start of implementation. It does not watch direction or spend during a run (yet).
- Fork PRs get a read-only token, so the status can't be posted. It's meant for internal team repos.
- Cost numbers are forecasts from a heuristic, not measurements.
- Claude Code is gated by the hook. Cursor and Codex use `lake-gate check` as a pre-run step.

## Privacy

The CLI has no telemetry and no analytics. The only network calls are to the GitHub API: `sync`, `ui` and `mcp` read and write your PR, and the Action runs inside your GitHub. Plans stay in your repo. The hosted review app and landing page count anonymous page views with GoatCounter. Your token and plan content go only to GitHub. The local `lake-gate ui` has no analytics at all.

## Development

```bash
npm test                 # unit + end-to-end tests (temp git repos, simulated hook payloads, mocked GitHub API)
npm run build:ui         # copies ui/ + the browser-safe core into landing/app (the Pages workflow does this)
node scripts/shots.cjs   # screenshots of a running `lake-gate ui` into ui-shots/ (needs playwright + Chrome)
node scripts/ui-e2e.cjs  # browser test: local server + fake GitHub, approve in the UI, check the posted comment
./scripts/demo.sh        # packs the npm tarball, installs it in a throwaway repo, runs the whole flow
```

MIT © Lake

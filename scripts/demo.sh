#!/usr/bin/env bash
# Local end-to-end demo with the packed npm tarball, a throwaway git repo and simulated Claude Code hook payloads.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TGZ="$(cd "$HERE" && npm pack --silent --pack-destination /tmp)"
DEMO="$(mktemp -d)"; cd "$DEMO"
git init -q -b main && git config user.email maya@example.com && git config user.name Maya
echo '{"name":"demo","private":true}' > package.json && git add . && git commit -qm init
npm i -D --silent "/tmp/$TGZ" >/dev/null
echo '$ npx lake-gate init'; npx lake-gate init
CLAUDE_PROJECT_DIR="$DEMO"; export CLAUDE_PROJECT_DIR
# Run the exact hook command that init wrote into .claude/settings.json
HOOK_CMD="$(node -e 'console.log(require("./.claude/settings.json").hooks.PreToolUse[0].hooks[0].command)')"
hook() { echo "$1" | sh -c "$HOOK_CMD"; echo; }
echo; echo '--- agent tries to write code before any plan'
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"default\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$DEMO/src/queue.ts\",\"content\":\"x\"}}"
echo '--- Claude exits plan mode (plan injected by Claude Code)'
PLAN=$(node -e 'console.log(JSON.stringify("# Add webhook retries\n\n1. Add a bounded retry queue with backoff in src/webhooks/queue.ts\n2. Database migration: retry_count column, reuse the idempotency record\n3. Fix typo in README\n4. Add replay and failure tests\n"))')
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"plan\",\"tool_name\":\"ExitPlanMode\",\"tool_input\":{\"plan\":$PLAN}}"
echo '--- agent tries to write code, plan not approved'
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"default\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$DEMO/src/queue.ts\",\"content\":\"x\"}}"
echo '--- read-only Bash is fine'
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"default\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"}}"
echo '(no output = no objection)'
echo; echo '$ npx lake-gate status'; npx lake-gate status
SHORT=$(npx lake-gate status | head -1 | awk '{print $3}' | sed 's/^v//')
echo; echo "--- simulate GitHub: author self-approves, then teammate @noah approves v$SHORT"
cat > events.json <<JSON
{"prAuthor":"maya","events":[
 {"login":"maya","type":"User","association":"OWNER","body":"/lake approve add-webhook-retries@$SHORT","createdAt":"2026-11-12T08:00:00Z"},
 {"login":"noah","type":"User","association":"MEMBER","body":"Retry cap looks right.\n/lake approve add-webhook-retries@$SHORT","createdAt":"2026-11-12T08:05:00Z"}]}
JSON
npx lake-gate sync --from-json events.json
echo '--- agent writes code now'
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"default\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$DEMO/src/queue.ts\",\"content\":\"x\"}}"
echo '(no output = allowed, normal Claude Code permissions apply)'
echo; echo '--- someone edits the plan after approval'
sed -i 's/with backoff/with backoff and jitter/' .lake/plans/add-webhook-retries.md
hook "{\"session_id\":\"s1\",\"cwd\":\"$DEMO\",\"permission_mode\":\"default\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$DEMO/src/queue.ts\",\"old_string\":\"x\",\"new_string\":\"y\"}}"
echo; echo '$ npx lake-gate check  (pre-run check for Cursor/Codex scripts)'; npx lake-gate check || echo "exit $?"
echo; echo "--- generated plan file"; cat .lake/plans/add-webhook-retries.md
rm -rf "$DEMO" "/tmp/$TGZ"

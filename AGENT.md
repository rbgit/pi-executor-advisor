# Agent setup notes for pi-executor-advisor

This repo is a pi package. It should install two extensions together:

1. `extensions/advisor/index.ts` — registers the private `advisor` tool, task briefs, completion judge, per-task routing, escalation, budget, and advisor config commands.
2. `extensions/advisor-gate/index.ts` — logs advisor/executor events, enforces the advisor gate, and serves the local dashboard/chat server.

Both extensions import `extensions/shared/classify.ts` (the shared task classifier). That file is **required at runtime** — never remove or prune it. Packaging has been verified: git installs clone the full repo, local installs reference the directory in place, and `npm pack` includes it.

## Install on a new machine

```bash
pi install git:github.com/rbgit/pi-executor-advisor
```

SSH form:

```bash
pi install git:git@github.com:rbgit/pi-executor-advisor.git
```

After install, restart pi or run `/reload` if pi already loaded the package.

## Configure advisor

Inside pi:

```text
/advisor-on <advisor-model>
```

or set both executor and advisor:

```text
/advisor-pair executor:<model> advisor:<model> [max:<n>] [words:<n>] [brief:<mode>] [budget:<usd>]
```

Check config:

```text
/advisor-status
```

Optional layers (all default off; see README for details):

```text
/advisor-brief <off|auto|always>          # advisor rewrites user prompts into execution briefs
/advisor-judge <off|auto|always> [retries:<n>]  # PASS/FAIL verdict on finished tasks, bounded fix rounds
/advisor-route simple:<model> complex:<model>   # per-task executor model routing ( /advisor-route off )
/advisor-escalate <model|off>             # stronger advisor for stuck/failed tasks
/advisor-budget <usd|off>                 # per-task USD cap across brief + advisor calls + judge
/advisor-cadence <n|off>                  # re-consult steering for long tasks
/advisor-max <n>  /advisor-words <n>      # advisor call cap and response length
```

Config persists in `~/.pi/agent/advisor.json` (or `$PI_CODING_AGENT_DIR/advisor.json`). Key fields: `brief`, `briefMaxWords`, `briefTimeoutMs`, `judge`, `judgeMaxRetries`, `routing`, `escalation`, `maxCostPerTask`.

Budget caveat: spend is summed from recorded usage costs; models without pricing metadata report zero cost and are invisible to the budget.

Privacy note for agents: briefs, advisor calls, and judge calls send the transcript **plus `git status`/`git diff HEAD` output** to the configured advisor (and escalation) provider. Do not enable these against repositories whose uncommitted changes may contain secrets unless the user has accepted that provider.

## Dashboard and chat server

The packaged `advisor-gate` extension starts a local-only HTTP server by default.

Default URLs:

```text
http://127.0.0.1:5000/       # event dashboard
http://127.0.0.1:5000/chat   # chat-style executor/advisor view
http://127.0.0.1:5000/events.json
```

Commands:

```text
/advisor-dashboard       # start/show dashboard URL
/advisor-dashboard-stop  # stop dashboard server
/advisor-gate            # show gate/log/dashboard status
```

Environment variables:

```bash
PI_ADVISOR_DASHBOARD=0          # disable auto-start
PI_ADVISOR_DASHBOARD_PORT=5000  # change port
PI_ADVISOR_GATE_MODE=attempt    # off | log | attempt | success
PI_ADVISOR_PG_DISABLE=1         # disable optional Postgres insert attempts
PI_ADVISOR_PG_URL=postgres://localhost/advisor_habitat?sslmode=disable
```

The server binds to `127.0.0.1` only. Do not expose it publicly unless you understand the transcript privacy implications.

## Where chat history comes from

The chat page reads local advisor-gate events from:

```text
~/.pi/agent/logs/advisor-gate.jsonl
```

If a fresh computer shows no chat history but the advisor tool works, that is expected until new advisor-gate events are created on that machine. Old chat history is not stored in this git repo and should not be committed. To migrate history manually, copy the JSONL file between machines outside git if you accept the privacy risk.

## Do not commit private data

Never commit:

- `~/.pi/agent/advisor.json`
- `~/.pi/agent/logs/advisor-gate.jsonl`
- session transcripts
- `.env` files
- API keys, SSH keys, provider tokens, or database dumps

The repo `.gitignore` is intended to block common local secrets/artifacts, but agents should still inspect diffs before committing.

## Local development

Run directly:

```bash
pi -e ./extensions/advisor/index.ts -e ./extensions/advisor-gate/index.ts
```

Or install locally:

```bash
pi install .
```

Check package contents:

```bash
npm pack --dry-run
```

If `npm pack --dry-run` creates a `.tgz` in this environment, remove it before committing.

## Verification checklist for agents

Before pushing changes:

```bash
git status --short
grep -n "registerCommand\|registerTool" extensions/advisor/index.ts extensions/advisor-gate/index.ts
git diff --check
npm pack --dry-run
rm -f pi-executor-advisor-*.tgz
find . -maxdepth 4 -type f | grep -Ei 'env|key|pem|secret|token|credential|advisor\.json|jsonl|db' || true
```

Typecheck against the real pi types (no compile step is needed for normal use; this is for verification only):

```bash
mkdir -p /tmp/pi-typecheck && cd /tmp/pi-typecheck && npm init -y >/dev/null
npm i -D typescript @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-tui typebox
cp -r <repo>/extensions . && npx tsc --noEmit --strict --target ES2022 --module ESNext \
  --moduleResolution bundler --skipLibCheck --allowImportingTsExtensions extensions/*/index.ts
```

Expected package files (all required; `npm pack --dry-run` must list every one):

- `LICENSE`
- `README.md`
- `AGENT.md` / `AGENTS.md`
- `package.json`
- `extensions/advisor/index.ts`
- `extensions/advisor-gate/index.ts`
- `extensions/shared/classify.ts` — shared classifier imported by both extensions; removing it breaks both at load time.

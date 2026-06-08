# Agent setup notes for pi-executor-advisor

This repo is a pi package. It should install two extensions together:

1. `extensions/advisor/index.ts` — registers the private `advisor` tool and advisor config commands.
2. `extensions/advisor-gate/index.ts` — logs advisor/executor events and serves the local dashboard/chat server.

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
/advisor-pair executor:<model> advisor:<model> [max:<n>] [words:<n>]
```

Check config:

```text
/advisor-status
```

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
find . -maxdepth 4 -type f | grep -Ei 'env|key|pem|secret|token|credential|advisor\.json|log|jsonl|db' || true
```

Expected package files include:

- `LICENSE`
- `README.md`
- `package.json`
- `extensions/advisor/index.ts`
- `extensions/advisor-gate/index.ts`

# pi-executor-advisor

A provider-agnostic **advisor tool** for [pi](https://github.com/earendil-works/pi-coding-agent)-style coding agent workflows.

`pi-executor-advisor` keeps your active model as the **executor** while giving it an optional private `advisor` tool backed by another, usually stronger, model. The executor can ask the advisor for strategy, checks, and course corrections, then continue using its normal tools and producing the user-facing answer.

This is useful when you want a fast or inexpensive executor model to do the work while periodically consulting a stronger reviewer model for hard decisions.

## Features

- **Executor/advisor split** — keep one model in control while consulting another model privately.
- **Provider agnostic** — works with any models registered in pi, not only Claude-native advisor pairs.
- **Private guidance** — advisor output is returned to the executor as tool output, not directly to the user.
- **Transcript-aware advice** — sends the current branch transcript to the advisor model.
- **Configurable limits** — cap advisor calls per user task and target response length.
- **Configurable advising cadence** — nudge the executor to re-consult the advisor periodically on long multi-step tasks.
- **Verifier-oriented advice** — when a transcript already contains a plan, attempt, or tool observations, the advisor is prompted to critique concrete evidence instead of giving generic tips.
- **Model resolution helpers** — use exact `provider/model`, exact model id, or a unique fuzzy substring.
- **No extra service** — this extension runs inside pi; no daemon or web server is required.

## How it works

1. You enable the extension and configure an advisor model.
2. The extension adds an `advisor` tool to pi's active tools.
3. For enabled sessions, it appends guidance telling the executor when to call the advisor.
4. When the executor calls `advisor`, the extension serializes the current conversation branch.
5. The serialized transcript is sent to the configured advisor model using pi's provider registry.
6. The advisor returns concise private guidance to the executor.
7. The executor remains responsible for all tool use and user-facing responses.

The advisor cannot call tools and does not directly mutate files. It only returns text guidance.

## Relationship to "How to Train Your Advisor"

This repository was reviewed against the paper **"How to Train Your Advisor: Steering Black-Box LLMs with Advisor Models"** (arXiv:2510.02453). The paper's main contribution is RL-training lightweight advisor models to produce dynamic, instance-specific advice for black-box student models. This repo does **not** implement RL training, reward optimization, or advisor model fine-tuning. It implements a lightweight runtime integration for pi.

| Paper idea | This repo | Gap | Action taken |
|---|---|---|---|
| Dynamic, per-instance natural-language advice | The `advisor` tool sends the current transcript to a configured model and returns advice to the executor. | Advisor quality depends on the chosen model/prompt; no learned policy. | Kept provider-agnostic runtime design. |
| 3-step/verifier setup: student attempt → advisor critique → revised student answer | The advisor sees the transcript, including orientation, attempts, and tool observations when called. | Previously prompted mostly as broad strategy. | Updated advisor system prompt to act as a concrete verifier/critic when evidence or an attempt exists. |
| Multi-turn advising cadence | The executor chooses when to call the advisor. | Purely dynamic tool-calling can under-use advisors. | Added `/advisor-cadence` to steer periodic re-consultation every N meaningful tool/action observations. |
| RL reward training and transferability | Not implemented. | Requires training data, reward functions, and model update infrastructure outside this extension. | Documented as out of scope for this runtime package. |

## Repository layout

```text
.
├── package.json
├── README.md
└── extensions/
    └── advisor/
        └── index.ts
```

This package currently ships one pi extension: `extensions/advisor/index.ts`.

## Requirements

- pi installed and working.
- Node.js compatible with your pi installation.
- At least one configured model provider/API key in pi.
- Optional but recommended: a stronger advisor model than your executor model.

## Installation

### Install from GitHub

After this repository is pushed to GitHub, install it as a pi package:

```bash
pi install git:github.com/rbgit/pi-executor-advisor
```

SSH form also works if your GitHub SSH key is configured:

```bash
pi install git:git@github.com:rbgit/pi-executor-advisor.git
```

### Install from a local checkout

From anywhere:

```bash
pi install /home/rachit/ai_projects/executor-advisor
```

Or from this repo:

```bash
pi install .
```

### Development mode

For one-off local testing without installing the package:

```bash
pi -e ./extensions/advisor/index.ts
```

For hot reload during development, place or symlink the extension under pi's auto-discovered extension directory and use `/reload` inside pi:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /home/rachit/ai_projects/executor-advisor/extensions/advisor ~/.pi/agent/extensions/advisor
```

Then run `/reload` in pi after edits.

## Quick start

Enable an advisor model:

```text
/advisor-on openai/gpt-5.3
```

Or switch both executor and advisor in one command:

```text
/advisor-pair executor:kimi-k2.5 advisor:gpt-5.5 max:3 words:120
```

Check status:

```text
/advisor-status
```

Once enabled, the executor can call the `advisor` tool during coding/research tasks.

## Commands

| Command | Description |
|---|---|
| `/advisor-on <advisor-model>` | Enable advisor mode and configure the advisor model. |
| `/advisor-off` | Disable advisor prompt steering and remove the advisor tool from active tools. |
| `/advisor-status` | Show current executor/advisor configuration. |
| `/advisor-pair executor:<model> advisor:<model> [max:<n>] [words:<n>]` | Set executor and advisor models together. |
| `/advisor-max <n>` | Set maximum advisor calls per user task. |
| `/advisor-words <n>` | Set target advisor response length. |
| `/advisor-cadence <n\|off>` | Set recommended re-consult cadence for long multi-step tasks. This is prompt steering, not enforcement. |
| `/advisor-reset` | Reset extension configuration to defaults. |

### Model specs

Model specs may be:

- exact `provider/model`
- exact model id
- exact model name
- unique fuzzy substring

Examples:

```text
/advisor-pair executor:kimi-k2.5 advisor:gpt-5.5 max:3 words:120
/advisor-pair sonnet opus
/advisor-on openai/gpt-5.3
/advisor-on anthropic/claude-opus-4-5
```

If a fuzzy model spec matches multiple models, the command reports an ambiguity error.

## Configuration

Configuration is persisted outside the repository at:

```text
~/.pi/agent/advisor.json
```

If `PI_CODING_AGENT_DIR` is set, the config path becomes:

```text
$PI_CODING_AGENT_DIR/advisor.json
```

Default configuration:

```json
{
  "enabled": false,
  "maxUsesPerTask": 3,
  "maxWords": 120,
  "maxOutputTokens": 2048,
  "maxTranscriptChars": 120000,
  "advisorCadence": 5,
  "thinkingLevel": "off"
}
```

Most users only need the commands above. Advanced users may edit `advisor.json` directly while pi is not running.

## Security and privacy

Important data-flow details:

- The advisor receives a serialized transcript of the current conversation branch.
- That transcript may include user prompts, assistant messages, tool results, file paths, command output, and snippets of project content already present in the pi session.
- The advisor model is called through pi's provider registry using your configured provider credentials.
- This repository does **not** store API keys.
- Runtime config lives in `~/.pi/agent/advisor.json`, not in this repo.
- API keys should remain in your normal pi/provider configuration, environment, or secret manager.

Before using this extension with private code, choose an advisor model/provider whose data handling policy you trust.

## What not to commit

Do not commit:

- `.env` files
- API keys or provider tokens
- SSH keys
- local pi config such as `advisor.json`
- logs or session transcripts
- database dumps containing private conversations

The included `.gitignore` is configured to avoid common accidental secret and local artifact commits.

## Troubleshooting

### `Advisor is not configured`

Run:

```text
/advisor-on <advisor-model>
```

or:

```text
/advisor-pair executor:<model> advisor:<model>
```

### `No API key available for advisor ...`

Configure the provider/API key in pi, then retry. The extension relies on pi's model registry and provider credentials.

### `Ambiguous model spec`

Use a more specific model name or exact `provider/model` form.

Example:

```text
/advisor-on openai/gpt-5.3
```

instead of:

```text
/advisor-on gpt
```

### Advisor cadence is too frequent or too sparse

Set the suggested re-consult interval:

```text
/advisor-cadence 5
```

Disable periodic cadence guidance:

```text
/advisor-cadence off
```

This setting is prompt steering. It nudges the executor when to ask for advice, but it does not enforce tool-call timing.

### Advisor call limit reached

Increase the per-task cap:

```text
/advisor-max 5
```

or continue without further advisor calls.

### Transcript truncated

The extension truncates very large transcripts using `maxTranscriptChars`. Increase it in `~/.pi/agent/advisor.json` if needed, but expect higher token usage and cost.

## Development

Clone the repo:

```bash
git clone git@github.com:rbgit/pi-executor-advisor.git
cd pi-executor-advisor
```

Run the extension directly:

```bash
pi -e ./extensions/advisor/index.ts
```

Install locally as a pi package:

```bash
pi install .
```

Useful inspection commands:

```bash
find . -maxdepth 4 -type f -not -path './.git/*' -print
grep -n "registerCommand\|registerTool" extensions/advisor/index.ts
```

Pi loads TypeScript extensions through its runtime loader, so no compile step is required for normal local use.

## Package manifest

`package.json` declares this as a pi package:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/advisor/index.ts"]
  }
}
```

## Contributing

Contributions are welcome once this repository is published.

Suggested workflow:

1. Open an issue describing the change.
2. Keep behavior provider-agnostic.
3. Avoid logging transcripts or secrets.
4. Test with at least one executor/advisor pair.
5. Update this README when commands or config change.

## License

No license has been added yet. Add a `LICENSE` file before publishing if you want others to have explicit rights to use, modify, and redistribute the project.

## Status

Early development. API, command names, and defaults may change.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple, type Api, type Message, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const VERSION = "0.2.0";
const TOOL_NAME = "advisor";

type BriefMode = "off" | "auto" | "always";

interface Config {
	enabled: boolean;
	advisor?: { provider: string; model: string; spec: string };
	maxUsesPerTask: number;
	maxWords: number;
	maxOutputTokens: number;
	maxTranscriptChars: number;
	advisorCadence: number;
	thinkingLevel: ModelThinkingLevel;
	brief: BriefMode;
	briefMaxWords: number;
	briefTimeoutMs: number;
}

interface AdvisorDetails {
	kind: "advisor" | "error" | "max_uses_exceeded" | "not_configured";
	version: string;
	advisor?: { provider: string; model: string; spec: string };
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		totalTokens: number;
	};
	callsUsed: number;
	maxUsesPerTask: number;
	truncatedTranscript: boolean;
	focus?: string;
	error?: string;
}

const DEFAULT_CONFIG: Config = {
	enabled: false,
	maxUsesPerTask: 3,
	maxWords: 120,
	maxOutputTokens: 2048,
	maxTranscriptChars: 120_000,
	advisorCadence: 5,
	thinkingLevel: "off",
	brief: "off",
	briefMaxWords: 250,
	briefTimeoutMs: 60_000,
};

const ADVISOR_SYSTEM = `You are a private advisor for a coding/research executor agent.

You see a serialized transcript of the executor's work. You do not call tools. You do not write user-facing final answers. Give strategic guidance to the executor only.

Generate dynamic, instance-specific advice. If the transcript includes an initial plan, implementation attempt, tool observations, or partial result, act primarily as a verifier/critic: identify concrete flaws, missing evidence, risky assumptions, and the smallest next checks that would improve the outcome.

Prefer clear, immediately actionable guidance over broad summaries. For coding tasks, mention exact files, commands, tests, or observations when visible; prefer efficient targeted exploration (for example rg/grep, focused reads, narrow tests) over generic advice. Avoid vague encouragement.

Return one concise response with:
- PLAN: the best next approach, if work remains
- CHECKS: specific risks, tests, or evidence to verify
- WHEN_TO_RECONSULT: when the executor should call advisor again, if useful
- STOP: say stop only if the executor should not proceed or should ask the user`;

const BRIEF_SYSTEM = `You are a task router and prompt engineer for a coding/research executor agent backed by a smaller, cheaper model. The executor has full tool access (read files, run shell commands, edit files) but performs far better with precise, unambiguous instructions.

Rewrite the raw user request into an execution brief the executor can follow reliably. Resolve ambiguity by stating the most reasonable interpretation as an explicit assumption. Never invent repository facts: anything not visible in the provided signals must appear as a verification step, not as a stated fact.

Return exactly these sections:
- GOAL: one sentence, the precise outcome.
- SCOPE: what is in and out of scope.
- ASSUMPTIONS: interpretations chosen where the request was ambiguous.
- PLAN: numbered, small, independently verifiable steps.
- FIRST_ACTIONS: exact first commands to run or files to read.
- ACCEPTANCE_CHECKS: how the executor verifies the task is actually complete.
- PITFALLS: likely mistakes for this specific task.
- ADVISOR: when the executor should call the advisor tool during execution.

No preamble, no closing remarks.`;

function executorGuidance(config: Config) {
	const cadence = config.advisorCadence > 0
		? `\nFor long multi-step tasks, use advisor as a periodic verifier after roughly ${config.advisorCadence} meaningful tool/action observations, or sooner when evidence contradicts the plan.`
		: "";
	return `

Advisor strategy guidance:
You have access to an \`advisor\` tool backed by a stronger reviewer model. When you call advisor, the current transcript is forwarded and private guidance is returned. You may pass an optional \`focus\` string to get a targeted answer to one specific question or decision.

Call advisor before substantive work on complex tasks: after quick orientation reads, before writing/editing, before committing to an interpretation, when stuck, when changing approach, and before declaring a difficult task complete after making results durable.${cadence}

Treat advisor output as verifier guidance over your current trajectory: reconcile it against tool evidence, adopt concrete checks where sensible, and explicitly note any contradiction instead of silently switching branches. The advisor never calls tools and never produces user-facing output; you remain the executor.`;
}

function configPath() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "advisor.json");
}

function loadConfig(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: Config) {
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	if (entry.type === "branch_summary") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function latestUserEntryIndex(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") return i;
	}
	return -1;
}

function countAdvisorCallsThisTask(branch: SessionEntry[]): number {
	const start = latestUserEntryIndex(branch) + 1;
	let count = 0;
	for (const entry of branch.slice(start)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = message.details as Partial<AdvisorDetails> | undefined;
		if (details?.kind === "advisor" || details?.kind === "error") count++;
	}
	return count;
}

function truncateTranscript(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const head = Math.min(10_000, Math.floor(maxChars * 0.15));
	const tail = Math.max(0, maxChars - head);
	return {
		truncated: true,
		text: `${text.slice(0, head)}\n\n[... transcript truncated by advisor extension; newest context follows ...]\n\n${text.slice(-tail)}`,
	};
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function formatModel(model?: { provider: string; model: string }) {
	return model ? `${model.provider}/${model.model}` : "(none)";
}

const BRIEF_COMPLEXITY =
	/(build|implement|create|write|add|modify|refactor|rewrite|migrate|upgrade|integrate|fix|debug|diagnose|failing|broken|regression|performance|bug|architecture|design|security|database|schema|migration|review|test)/i;

function briefWorthy(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.length >= 240) return true;
	return trimmed.length >= 40 && BRIEF_COMPLEXITY.test(trimmed);
}

function gatherRepoSignals(cwd: string): string {
	const lines: string[] = [`Working directory: ${cwd}`];
	try {
		const entries = fs
			.readdirSync(cwd, { withFileTypes: true })
			.filter((entry) => entry.name !== ".git")
			.slice(0, 60)
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
		if (entries.length) lines.push(`Top-level entries: ${entries.join(", ")}`);
	} catch {
		// unreadable cwd: brief proceeds without listing
	}
	for (const readme of ["README.md", "README.rst", "README.txt", "README"]) {
		try {
			const text = fs.readFileSync(path.join(cwd, readme), "utf8").slice(0, 1500);
			lines.push(`${readme} (excerpt):\n${text}`);
			break;
		} catch {
			// try next candidate
		}
	}
	return lines.join("\n\n");
}

function transcriptTail(ctx: ExtensionContext, maxChars: number): string {
	const messages = ctx.sessionManager
		.getBranch()
		.map(entryToMessage)
		.filter((message) => message !== undefined);
	if (messages.length === 0) return "";
	return serializeConversation(convertToLlm(messages)).slice(-maxChars);
}

type BriefResult =
	| { ok: true; text: string; usage: AdvisorDetails["usage"] }
	| { ok: false; error: string };

async function generateBrief(prompt: string, config: Config, ctx: ExtensionContext): Promise<BriefResult> {
	if (!config.advisor) return { ok: false, error: "not_configured" };
	const advisorModel = ctx.modelRegistry.find(config.advisor.provider, config.advisor.model);
	if (!advisorModel) return { ok: false, error: `advisor model not found: ${formatModel(config.advisor)}` };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisorModel);
	if (!auth.ok || !auth.apiKey) return { ok: false, error: auth.ok ? `no API key for ${modelLabel(advisorModel)}` : auth.error };

	const tail = transcriptTail(ctx, 6000);
	const briefPrompt = [
		`<user_request>\n${prompt}\n</user_request>`,
		`<executor>\n${ctx.model ? modelLabel(ctx.model) : "unknown"} (assume a smaller, faster model than you)\n</executor>`,
		`<repo_signals>\n${gatherRepoSignals(ctx.cwd)}\n</repo_signals>`,
		tail ? `<recent_transcript_tail>\n${tail}\n</recent_transcript_tail>` : "",
		`Rewrite the user request into an execution brief for the executor now. Keep it under ${config.briefMaxWords} words.`,
	]
		.filter(Boolean)
		.join("\n\n");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.briefTimeoutMs);
	try {
		const response = await completeSimple(
			advisorModel,
			{
				systemPrompt: BRIEF_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: briefPrompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				maxTokens: config.maxOutputTokens,
				reasoning: config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
			},
		);
		if (response.stopReason === "error") return { ok: false, error: response.errorMessage || "brief call failed" };
		if (response.stopReason === "aborted") return { ok: false, error: `timed out after ${config.briefTimeoutMs}ms` };
		const text = extractText(response);
		if (!text) return { ok: false, error: "advisor returned an empty brief" };
		return {
			ok: true,
			text,
			usage: {
				input: response.usage.input,
				output: response.usage.output,
				cacheRead: response.usage.cacheRead,
				cacheWrite: response.usage.cacheWrite,
				cost: response.usage.cost.total,
				totalTokens: response.usage.totalTokens,
			},
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}

function splitProviderModel(spec: string, providers: Set<string>): { provider: string; model: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = spec.slice(0, slash);
	if (!providers.has(provider)) return undefined;
	return { provider, model: spec.slice(slash + 1) };
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
}

function resolveModel(ctx: { modelRegistry: ExtensionCommandContext["modelRegistry"] }, spec: string): { ok: true; model: Model<Api> } | { ok: false; error: string } {
	const normalized = spec.trim();
	if (!normalized) return { ok: false, error: "Empty model spec" };

	ctx.modelRegistry.refresh();
	const all = ctx.modelRegistry.getAll();
	const providers = new Set(all.map((model) => model.provider));
	const explicit = splitProviderModel(normalized, providers);
	if (explicit) {
		const model = ctx.modelRegistry.find(explicit.provider, explicit.model);
		if (model) return { ok: true, model };
		return { ok: false, error: `No model found for ${normalized}` };
	}

	const lower = normalized.toLowerCase();
	const exact = all.filter(
		(model) =>
			model.id.toLowerCase() === lower ||
			model.name?.toLowerCase() === lower ||
			`${model.provider}/${model.id}`.toLowerCase() === lower,
	);
	if (exact.length === 1) return { ok: true, model: exact[0] };
	if (exact.length > 1) return { ok: false, error: `Ambiguous model spec ${normalized}: ${exact.map(modelLabel).slice(0, 8).join(", ")}` };

	const fuzzy = all.filter(
		(model) =>
			model.id.toLowerCase().includes(lower) ||
			model.name?.toLowerCase().includes(lower) ||
			`${model.provider}/${model.id}`.toLowerCase().includes(lower),
	);
	if (fuzzy.length === 1) return { ok: true, model: fuzzy[0] };
	if (fuzzy.length === 0) return { ok: false, error: `No model matches ${normalized}` };
	return { ok: false, error: `Ambiguous model spec ${normalized}: ${fuzzy.map(modelLabel).slice(0, 8).join(", ")}` };
}

function parsePairArgs(args: string): { executor?: string; advisor?: string; max?: number; words?: number; brief?: BriefMode; errors: string[] } {
	const out: { executor?: string; advisor?: string; max?: number; words?: number; brief?: BriefMode; errors: string[] } = { errors: [] };
	const positional: string[] = [];
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const match = token.match(/^(executor|exec|advisor|adv|max|uses|words|brief):(.+)$/i);
		if (!match) {
			positional.push(token);
			continue;
		}
		const key = match[1].toLowerCase();
		const value = match[2];
		if (key === "executor" || key === "exec") out.executor = value;
		else if (key === "advisor" || key === "adv") out.advisor = value;
		else if (key === "max" || key === "uses") out.max = Number(value);
		else if (key === "words") out.words = Number(value);
		else if (key === "brief") {
			const mode = value.toLowerCase();
			if (mode === "off" || mode === "auto" || mode === "always") out.brief = mode;
			else out.errors.push("brief must be off, auto, or always");
		}
	}
	if (!out.executor && positional[0]) out.executor = positional[0];
	if (!out.advisor && positional[1]) out.advisor = positional[1];
	if (out.max !== undefined && (!Number.isInteger(out.max) || out.max < 0)) out.errors.push("max must be a non-negative integer");
	if (out.words !== undefined && (!Number.isInteger(out.words) || out.words < 20)) out.errors.push("words must be an integer >= 20");
	return out;
}

function statusText(config: Config, executor?: Model<Api>) {
	return [
		`advisor: ${config.enabled ? "on" : "off"}`,
		`executor: ${executor ? modelLabel(executor) : "(none)"}`,
		`advisor model: ${formatModel(config.advisor)}`,
		`max uses/task: ${config.maxUsesPerTask}`,
		`target words: ${config.maxWords}`,
		`advisor cadence: ${config.advisorCadence > 0 ? `~${config.advisorCadence} meaningful steps` : "off"}`,
		`task brief: ${config.brief}`,
		`config: ${configPath()}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();

	function syncActiveTools() {
		const active = pi.getActiveTools();
		const hasAdvisor = active.includes(TOOL_NAME);
		const shouldEnable = config.enabled && Boolean(config.advisor);
		if (shouldEnable && !hasAdvisor) pi.setActiveTools([...active, TOOL_NAME]);
		if (!shouldEnable && hasAdvisor) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	}

	function updateStatus(ctx: { hasUI: boolean; ui: { setStatus(key: string, value: string | undefined): void } }) {
		if (ctx.hasUI) ctx.ui.setStatus("advisor", config.enabled && config.advisor ? `advisor:${config.advisor.model}` : undefined);
	}

	function persist(next: Config) {
		config = next;
		saveConfig(config);
		syncActiveTools();
	}

	pi.registerCommand("advisor-status", {
		description: "Show executor/advisor configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusText(config, ctx.model), "info");
		},
	});

	pi.registerCommand("advisor-on", {
		description: "Enable advisor tool with an advisor model: /advisor-on <model>",
		handler: async (args, ctx) => {
			const spec = args.trim();
			if (!spec && !config.advisor) {
				ctx.ui.notify("Usage: /advisor-on <advisor-model>", "error");
				return;
			}
			let advisor = config.advisor;
			if (spec) {
				const resolved = resolveModel(ctx, spec);
				if (!resolved.ok) {
					ctx.ui.notify(resolved.error, "error");
					return;
				}
				advisor = { provider: resolved.model.provider, model: resolved.model.id, spec };
			}
			persist({ ...config, enabled: true, advisor });
			updateStatus(ctx);
			ctx.ui.notify(`Advisor enabled: ${formatModel(advisor)}`, "info");
		},
	});

	pi.registerCommand("advisor-off", {
		description: "Disable advisor prompt steering and advisor tool use",
		handler: async (_args, ctx) => {
			persist({ ...config, enabled: false });
			updateStatus(ctx);
			ctx.ui.notify("Advisor disabled", "info");
		},
	});

	pi.registerCommand("advisor-max", {
		description: "Set max advisor calls per user task",
		handler: async (args, ctx) => {
			const value = Number(args.trim());
			if (!Number.isInteger(value) || value < 0) {
				ctx.ui.notify("Usage: /advisor-max <non-negative integer>", "error");
				return;
			}
			persist({ ...config, maxUsesPerTask: value });
			updateStatus(ctx);
			ctx.ui.notify(`Advisor max uses/task: ${value}`, "info");
		},
	});

	pi.registerCommand("advisor-words", {
		description: "Set advisor target word count",
		handler: async (args, ctx) => {
			const value = Number(args.trim());
			if (!Number.isInteger(value) || value < 20) {
				ctx.ui.notify("Usage: /advisor-words <integer >= 20>", "error");
				return;
			}
			persist({ ...config, maxWords: value });
			updateStatus(ctx);
			ctx.ui.notify(`Advisor target words: ${value}`, "info");
		},
	});

	pi.registerCommand("advisor-cadence", {
		description: "Set recommended advisor re-consult cadence in meaningful tool/action steps, or off",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			const value = raw === "off" || raw === "0" ? 0 : Number(raw);
			if (!Number.isInteger(value) || value < 0) {
				ctx.ui.notify("Usage: /advisor-cadence <non-negative integer|off>", "error");
				return;
			}
			persist({ ...config, advisorCadence: value });
			updateStatus(ctx);
			ctx.ui.notify(value > 0 ? `Advisor cadence: ~${value} meaningful steps` : "Advisor cadence disabled", "info");
		},
	});

	pi.registerCommand("advisor-brief", {
		description: "Set advisor task brief mode (advisor rewrites the user prompt into an execution brief): /advisor-brief <off|auto|always>",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			if (!raw) {
				ctx.ui.notify(`Advisor brief mode: ${config.brief}`, "info");
				return;
			}
			if (raw !== "off" && raw !== "auto" && raw !== "always") {
				ctx.ui.notify("Usage: /advisor-brief <off|auto|always>", "error");
				return;
			}
			persist({ ...config, brief: raw });
			updateStatus(ctx);
			ctx.ui.notify(`Advisor brief mode: ${raw}`, "info");
		},
	});

	pi.registerCommand("advisor-reset", {
		description: "Reset advisor extension configuration",
		handler: async (_args, ctx) => {
			persist({ ...DEFAULT_CONFIG });
			updateStatus(ctx);
			ctx.ui.notify("Advisor config reset", "info");
		},
	});

	pi.registerCommand("advisor-pair", {
		description: "Set executor and advisor models: /advisor-pair executor:<model> advisor:<model>",
		handler: async (args, ctx) => {
			const parsed = parsePairArgs(args);
			if (parsed.errors.length) {
				ctx.ui.notify(parsed.errors.join("\n"), "error");
				return;
			}
			if (!parsed.executor || !parsed.advisor) {
				ctx.ui.notify("Usage: /advisor-pair executor:<model> advisor:<model> [max:<n>] [words:<n>]", "error");
				return;
			}

			const executor = resolveModel(ctx, parsed.executor);
			if (!executor.ok) {
				ctx.ui.notify(`Executor: ${executor.error}`, "error");
				return;
			}
			const advisor = resolveModel(ctx, parsed.advisor);
			if (!advisor.ok) {
				ctx.ui.notify(`Advisor: ${advisor.error}`, "error");
				return;
			}
			const switched = await pi.setModel(executor.model);
			if (!switched) {
				ctx.ui.notify(`No API key available for executor ${modelLabel(executor.model)}`, "error");
				return;
			}
			persist({
				...config,
				enabled: true,
				advisor: { provider: advisor.model.provider, model: advisor.model.id, spec: parsed.advisor },
				maxUsesPerTask: parsed.max ?? config.maxUsesPerTask,
				maxWords: parsed.words ?? config.maxWords,
				brief: parsed.brief ?? config.brief,
			});
			updateStatus(ctx);
			ctx.ui.notify(`Executor: ${modelLabel(executor.model)}\nAdvisor: ${modelLabel(advisor.model)}`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.enabled || !config.advisor) return;
		const systemPrompt = `${executorGuidance(config)}\n\n${event.systemPrompt}`;
		const wantBrief = config.brief === "always" || (config.brief === "auto" && briefWorthy(event.prompt ?? ""));
		if (!wantBrief) return { systemPrompt };

		if (ctx.hasUI) ctx.ui.notify(`Advisor brief: consulting ${formatModel(config.advisor)}...`, "info");
		const brief = await generateBrief(event.prompt ?? "", config, ctx);
		if (!brief.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Advisor brief skipped: ${brief.error}`, "warning");
			return { systemPrompt };
		}

		const content = `<advisor_brief advisor="${formatModel(config.advisor)}">\n${brief.text}\n</advisor_brief>\n\nThis execution brief was generated by the advisor model from the user's request before execution started. Follow its plan, first actions, and acceptance checks unless tool evidence contradicts them. The user's original request remains authoritative for intent.`;
		return {
			systemPrompt,
			message: {
				customType: "advisor-brief",
				content,
				display: true,
				details: { kind: "brief", version: VERSION, advisor: config.advisor, usage: brief.usage },
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		syncActiveTools();
		updateStatus(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Advisor",
		description: "Consult the configured stronger advisor model for private strategic guidance. The advisor receives a serialized transcript plus an optional focus question, cannot call tools, and does not produce user-facing output.",
		promptSnippet: "Consult a stronger model for private plan/correction guidance; optional focus question.",
		promptGuidelines: [
			"Use advisor before substantive work on complex coding/research tasks, after quick orientation, when stuck, before changing approach, and before declaring difficult work complete.",
			"Use advisor as a verifier over the current trajectory: let it critique concrete tool evidence, partial plans, and implementation attempts.",
			"Pass `focus` with one targeted question when you need a specific decision checked (for example: is this migration order safe?); omit it for a general trajectory review.",
		],
		parameters: Type.Object({
			focus: Type.Optional(
				Type.String({
					description: "Optional targeted question or decision for the advisor to address first. Omit for a general review of the current trajectory.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const branch = ctx.sessionManager.getBranch();
			const callsUsed = countAdvisorCallsThisTask(branch);

			if (!config.enabled || !config.advisor) {
				return {
					content: [{ type: "text", text: "Advisor is not configured. Ask the user to run /advisor-on <model> or /advisor-pair." }],
					details: { kind: "not_configured", version: VERSION, callsUsed, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: false } satisfies AdvisorDetails,
				};
			}

			if (callsUsed >= config.maxUsesPerTask) {
				return {
					content: [{ type: "text", text: `Advisor max uses exceeded for this task (${callsUsed}/${config.maxUsesPerTask}). Continue without further advice.` }],
					details: { kind: "max_uses_exceeded", version: VERSION, advisor: config.advisor, callsUsed, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: false } satisfies AdvisorDetails,
				};
			}

			const advisorModel = ctx.modelRegistry.find(config.advisor.provider, config.advisor.model);
			if (!advisorModel) {
				return {
					content: [{ type: "text", text: `Configured advisor model no longer exists: ${formatModel(config.advisor)}` }],
					details: { kind: "error", version: VERSION, advisor: config.advisor, callsUsed: callsUsed + 1, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: false, error: "model_not_found" } satisfies AdvisorDetails,
				};
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisorModel);
			if (!auth.ok || !auth.apiKey) {
				return {
					content: [{ type: "text", text: auth.ok ? `No API key available for advisor ${modelLabel(advisorModel)}` : auth.error }],
					details: { kind: "error", version: VERSION, advisor: config.advisor, callsUsed: callsUsed + 1, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: false, error: auth.ok ? "no_api_key" : auth.error } satisfies AdvisorDetails,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `Consulting ${modelLabel(advisorModel)}...` }], details: undefined });

			const messages = branch.map(entryToMessage).filter((message) => message !== undefined);
			const llmMessages = convertToLlm(messages);
			const serialized = serializeConversation(llmMessages);
			const truncated = truncateTranscript(serialized, config.maxTranscriptChars);
			const focus = typeof params.focus === "string" ? params.focus.trim().slice(0, 2000) : "";

			const advisorPrompt = `<executor_context>\nExecutor model: ${ctx.model ? modelLabel(ctx.model) : "unknown"}\nWorking directory: ${ctx.cwd}\nAdvisor call: ${callsUsed + 1}/${config.maxUsesPerTask}\nRecommended re-consult cadence: ${config.advisorCadence > 0 ? `~${config.advisorCadence} meaningful executor observations` : "off"}\nTranscript truncated: ${truncated.truncated ? "yes" : "no"}\n</executor_context>\n${focus ? `\n<executor_focus>\n${focus}\n</executor_focus>\n` : ""}\n<transcript>\n${truncated.text}\n</transcript>\n\nGive private guidance to the executor now. Keep it under ${config.maxWords} words. Be concrete, evidence-grounded, and verifier-oriented when the transcript contains an initial attempt or tool observations.${focus ? " Address the executor's focus question first, then verify the broader trajectory." : ""}`;

			const advisorMessages: Message[] = [
				{
					role: "user",
					content: [{ type: "text", text: advisorPrompt }],
					timestamp: Date.now(),
				},
			];

			const response = await completeSimple(
				advisorModel,
				{ systemPrompt: ADVISOR_SYSTEM, messages: advisorMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					maxTokens: config.maxOutputTokens,
					reasoning: config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
				},
			);

			if (response.stopReason === "error") {
				const error = response.errorMessage || "advisor call failed";
				return {
					content: [{ type: "text", text: `Advisor error: ${error}. Continue without advice or ask user to adjust advisor config.` }],
					details: { kind: "error", version: VERSION, advisor: config.advisor, callsUsed: callsUsed + 1, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: truncated.truncated, error } satisfies AdvisorDetails,
				};
			}
			if (response.stopReason === "aborted") {
				return {
					content: [{ type: "text", text: "Advisor call aborted." }],
					details: { kind: "error", version: VERSION, advisor: config.advisor, callsUsed: callsUsed + 1, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: truncated.truncated, error: "aborted" } satisfies AdvisorDetails,
				};
			}

			const advice = extractText(response) || "(advisor returned no text)";
			return {
				content: [{ type: "text", text: advice }],
				details: {
					kind: "advisor",
					version: VERSION,
					advisor: config.advisor,
					usage: {
						input: response.usage.input,
						output: response.usage.output,
						cacheRead: response.usage.cacheRead,
						cacheWrite: response.usage.cacheWrite,
						cost: response.usage.cost.total,
						totalTokens: response.usage.totalTokens,
					},
					callsUsed: callsUsed + 1,
					maxUsesPerTask: config.maxUsesPerTask,
					truncatedTranscript: truncated.truncated,
					focus: focus || undefined,
				} satisfies AdvisorDetails,
			};
		},
		renderCall(args, theme) {
			const focus = typeof (args as { focus?: string } | undefined)?.focus === "string" ? (args as { focus: string }).focus : "";
			let out = theme.fg("toolTitle", theme.bold("advisor")) + theme.fg("muted", ` ${formatModel(config.advisor)}`);
			if (focus) out += theme.fg("dim", ` ${focus.length > 80 ? `${focus.slice(0, 77)}...` : focus}`);
			return new Text(out, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as AdvisorDetails | undefined;
			const text = result.content.find((part) => part.type === "text");
			let out = "";
			if (details?.kind === "advisor") out += theme.fg("success", "✓ advisor guidance");
			else if (details?.kind === "max_uses_exceeded") out += theme.fg("warning", "advisor cap reached");
			else out += theme.fg("warning", "advisor");
			if (details?.advisor) out += theme.fg("muted", ` ${formatModel(details.advisor)}`);
			if (details?.usage) out += theme.fg("dim", ` $${details.usage.cost.toFixed(4)} ↑${details.usage.input} ↓${details.usage.output}`);
			if (details?.truncatedTranscript) out += theme.fg("warning", " truncated");
			if (expanded && text?.type === "text") out += `\n${theme.fg("toolOutput", text.text)}`;
			else if (text?.type === "text") {
				const lines = text.text.split("\n").slice(0, 5).join("\n");
				out += `\n${theme.fg("toolOutput", lines)}`;
			}
			return new Text(out, 0, 0);
		},
	});
}

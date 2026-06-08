import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple, type Api, type Message, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const VERSION = "0.1.0";
const TOOL_NAME = "advisor";

interface Config {
	enabled: boolean;
	advisor?: { provider: string; model: string; spec: string };
	maxUsesPerTask: number;
	maxWords: number;
	maxOutputTokens: number;
	maxTranscriptChars: number;
	thinkingLevel: ModelThinkingLevel;
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
	error?: string;
}

const DEFAULT_CONFIG: Config = {
	enabled: false,
	maxUsesPerTask: 3,
	maxWords: 120,
	maxOutputTokens: 2048,
	maxTranscriptChars: 120_000,
	thinkingLevel: "off",
};

const ADVISOR_SYSTEM = `You are a private advisor for a coding/research executor agent.

You see a serialized transcript of the executor's work. You do not call tools. You do not write user-facing final answers. Give strategic guidance to the executor only.

Return one concise response with:
- PLAN: the best next approach, if work remains
- CHECKS: specific risks, tests, or evidence to verify
- STOP: say stop only if the executor should not proceed or should ask the user

Prefer course corrections over broad summaries. Mention exact files, commands, assumptions, and contradictions when visible.`;

const EXECUTOR_GUIDANCE = `

Advisor strategy guidance:
You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes no parameters. When you call advisor(), the current transcript is forwarded and private guidance is returned.

Call advisor before substantive work on complex tasks: after quick orientation reads, before writing/editing, before committing to an interpretation, when stuck, when changing approach, and before declaring a difficult task complete after making results durable.

Give advisor guidance serious weight. If tool evidence contradicts it, reconcile explicitly instead of silently switching branches. The advisor never calls tools and never produces user-facing output; you remain the executor.`;

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

function parsePairArgs(args: string): { executor?: string; advisor?: string; max?: number; words?: number; errors: string[] } {
	const out: { executor?: string; advisor?: string; max?: number; words?: number; errors: string[] } = { errors: [] };
	const positional: string[] = [];
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const match = token.match(/^(executor|exec|advisor|adv|max|uses|words):(.+)$/i);
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
			});
			updateStatus(ctx);
			ctx.ui.notify(`Executor: ${modelLabel(executor.model)}\nAdvisor: ${modelLabel(advisor.model)}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!config.enabled || !config.advisor) return;
		return { systemPrompt: `${EXECUTOR_GUIDANCE}\n\n${event.systemPrompt}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		syncActiveTools();
		updateStatus(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Advisor",
		description: "Consult the configured stronger advisor model for private strategic guidance. Takes no parameters. The advisor receives a serialized transcript, cannot call tools, and does not produce user-facing output.",
		promptSnippet: "Consult a stronger model for private plan/correction guidance; no parameters.",
		promptGuidelines: [
			"Use advisor before substantive work on complex coding/research tasks, after quick orientation, when stuck, before changing approach, and before declaring difficult work complete.",
			"The advisor tool takes no parameters; do not pass text or questions to advisor.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
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

			const advisorPrompt = `<executor_context>\nExecutor model: ${ctx.model ? modelLabel(ctx.model) : "unknown"}\nWorking directory: ${ctx.cwd}\nAdvisor call: ${callsUsed + 1}/${config.maxUsesPerTask}\nTranscript truncated: ${truncated.truncated ? "yes" : "no"}\n</executor_context>\n\n<transcript>\n${truncated.text}\n</transcript>\n\nGive private guidance to the executor now. Keep it under ${config.maxWords} words.`;

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
				} satisfies AdvisorDetails,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("advisor")) + theme.fg("muted", ` ${formatModel(config.advisor)}`), 0, 0);
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

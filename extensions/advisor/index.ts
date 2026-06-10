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
import { briefWorthy, classifyTask } from "../shared/classify.ts";

const VERSION = "0.3.0";
const TOOL_NAME = "advisor";

type BriefMode = "off" | "auto" | "always";
type JudgeMode = "off" | "auto" | "always";

interface ModelRef {
	provider: string;
	model: string;
	spec: string;
}

interface Config {
	enabled: boolean;
	advisor?: ModelRef;
	maxUsesPerTask: number;
	maxWords: number;
	maxOutputTokens: number;
	maxTranscriptChars: number;
	advisorCadence: number;
	thinkingLevel: ModelThinkingLevel;
	brief: BriefMode;
	briefMaxWords: number;
	briefTimeoutMs: number;
	judge: JudgeMode;
	judgeMaxRetries: number;
	routing: { enabled: boolean; simple?: ModelRef; complex?: ModelRef };
	escalation?: ModelRef;
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
	escalated?: string;
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
	judge: "off",
	judgeMaxRetries: 1,
	routing: { enabled: false },
};

const ADVISOR_SYSTEM = `You are a private advisor for a coding/research executor agent.

You see a serialized transcript of the executor's work. You do not call tools. You do not write user-facing final answers. Give strategic guidance to the executor only.

Generate dynamic, instance-specific advice. If the transcript includes an initial plan, implementation attempt, tool observations, or partial result, act primarily as a verifier/critic: identify concrete flaws, missing evidence, risky assumptions, and the smallest next checks that would improve the outcome.

Prefer clear, immediately actionable guidance over broad summaries. For coding tasks, mention exact files, commands, tests, or observations when visible; prefer efficient targeted exploration (for example rg/grep, focused reads, narrow tests) over generic advice. Avoid vague encouragement.

Return one concise response with:
- PLAN: the best next approach, if work remains
- CHECKS: specific risks, tests, or evidence to verify
- WHEN_TO_RECONSULT: when the executor should call advisor again, if useful
- STOP: include this section only if the executor should not proceed or should ask the user; omit it entirely otherwise`;

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

const JUDGE_SYSTEM = `You are a completion judge for a coding/research executor agent. You receive the user's request, a transcript of the executor's finished attempt, the current workspace diff, and (if present) an execution brief with acceptance checks. Decide whether the request was actually completed.

Judge against the user's request first and the brief's ACCEPTANCE_CHECKS second. FAIL only for substantive gaps: missing requested functionality, claimed-but-unrun verification, failing tests, or unmet explicit requirements. Do not fail for stylistic preferences. If the executor reasonably stopped to ask the user a clarifying question or report a genuine blocker, return PASS.

Output format (exactly):
VERDICT: PASS or FAIL on the first line.
REASONS: short, evidence-grounded bullets citing the transcript or diff.
REQUIRED_FIXES: only if FAIL - the minimal concrete actions needed to finish, each independently verifiable.`;

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

type ConsultResult =
	| { ok: true; text: string; usage: AdvisorDetails["usage"]; model: Model<Api> }
	| { ok: false; error: string };

async function consultModel(
	ref: ModelRef,
	config: Config,
	ctx: ExtensionContext,
	args: { system: string; prompt: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ConsultResult> {
	const model = ctx.modelRegistry.find(ref.provider, ref.model);
	if (!model) return { ok: false, error: `model not found: ${formatModel(ref)}` };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return { ok: false, error: auth.ok ? `no API key for ${modelLabel(model)}` : auth.error };

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	args.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = args.timeoutMs ? setTimeout(() => controller.abort(), args.timeoutMs) : undefined;
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: args.prompt }], timestamp: Date.now() }];
	try {
		const response = await completeSimple(
			model,
			{ systemPrompt: args.system, messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				maxTokens: config.maxOutputTokens,
				reasoning: config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
			},
		);
		if (response.stopReason === "error") return { ok: false, error: response.errorMessage || "advisor call failed" };
		if (response.stopReason === "aborted") {
			return { ok: false, error: args.timeoutMs && !args.signal?.aborted ? `timed out after ${args.timeoutMs}ms` : "aborted" };
		}
		const text = extractText(response);
		if (!text) return { ok: false, error: "model returned no text" };
		return {
			ok: true,
			text,
			model,
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
		if (timer) clearTimeout(timer);
		args.signal?.removeEventListener("abort", onAbort);
	}
}

async function gitContext(pi: ExtensionAPI, cwd: string, maxChars: number): Promise<string> {
	try {
		const status = await pi.exec("git", ["status", "--short"], { cwd, timeout: 5000 });
		if (status.code !== 0) return "";
		let out = "";
		if (status.stdout.trim()) out += `git status --short:\n${status.stdout.trim()}\n\n`;
		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd, timeout: 10_000 });
		if (diff.code === 0 && diff.stdout.trim()) out += `git diff HEAD:\n${diff.stdout}`;
		if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[... workspace diff truncated ...]`;
		return out.trim();
	} catch {
		return "";
	}
}

function gateLogPath(): string {
	return path.join(path.dirname(configPath()), "logs", "advisor-gate.jsonl");
}

function appendGateLog(row: Record<string, unknown>) {
	try {
		const file = gateLogPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
	} catch {
		// observability only; never block on logging
	}
}

/** Mine the local advisor-gate event log for this repo's recent failure modes. */
function pastFailureSignals(cwd: string, limit = 5): string {
	try {
		const file = gateLogPath();
		const stat = fs.statSync(file);
		const size = Math.min(stat.size, 262_144);
		if (size === 0) return "";
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(size);
		fs.readSync(fd, buf, 0, size, stat.size - size);
		fs.closeSync(fd);
		const signals: string[] = [];
		const lines = buf.toString("utf8").split("\n").filter(Boolean).reverse();
		for (const line of lines) {
			if (signals.length >= limit) break;
			let row: Record<string, unknown>;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (row.cwd !== cwd) continue;
			let signal = "";
			if (row.event === "mutation_blocked" && row.reason) signal = `mutation blocked: ${String(row.reason).slice(0, 160)}`;
			else if (row.event === "judge_result" && row.verdict === "FAIL") signal = `completion judge failed: ${String(row.contentPreview ?? "").slice(0, 160)}`;
			else if (row.event === "run_end" && row.required && row.satisfied === false) signal = "a previous required task ended without satisfying the advisor gate";
			if (signal && !signals.includes(signal)) signals.push(signal);
		}
		return signals.map((s) => `- ${s}`).join("\n");
	} catch {
		return "";
	}
}

async function generateBrief(
	prompt: string,
	config: Config,
	ctx: ExtensionContext,
	extra: { executorLabel: string; diff: string },
): Promise<ConsultResult> {
	if (!config.advisor) return { ok: false, error: "not_configured" };
	const tail = transcriptTail(ctx, 6000);
	const failures = pastFailureSignals(ctx.cwd);
	const briefPrompt = [
		`<user_request>\n${prompt}\n</user_request>`,
		`<executor>\n${extra.executorLabel} (assume a smaller, faster model than you)\n</executor>`,
		`<repo_signals>\n${gatherRepoSignals(ctx.cwd)}\n</repo_signals>`,
		extra.diff ? `<workspace_diff>\n${extra.diff}\n</workspace_diff>` : "",
		failures ? `<past_failures_in_this_repo>\n${failures}\n</past_failures_in_this_repo>` : "",
		tail ? `<recent_transcript_tail>\n${tail}\n</recent_transcript_tail>` : "",
		`Rewrite the user request into an execution brief for the executor now. Keep it under ${config.briefMaxWords} words. Use the past failures, if any, to sharpen PITFALLS and ACCEPTANCE_CHECKS.`,
	]
		.filter(Boolean)
		.join("\n\n");
	return consultModel(config.advisor, config, ctx, { system: BRIEF_SYSTEM, prompt: briefPrompt, timeoutMs: config.briefTimeoutMs });
}

function messageText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return extractText(message as { content: Array<{ type: string; text?: string }> });
	return "";
}

/** Entries belonging to the current user task: everything from the latest user message onward. */
function currentTaskEntries(branch: SessionEntry[]): { entries: SessionEntry[]; prompt: string } {
	const start = latestUserEntryIndex(branch);
	if (start < 0) return { entries: [], prompt: "" };
	const userEntry = branch[start];
	const prompt = userEntry.type === "message" ? messageText(userEntry.message as { content: unknown }) : "";
	return { entries: branch.slice(start), prompt };
}

function judgeFailuresThisTask(branch: SessionEntry[]): number {
	return currentTaskEntries(branch).entries.filter(
		(entry) => entry.type === "custom_message" && entry.customType === "advisor-judge",
	).length;
}

function briefContentThisTask(branch: SessionEntry[]): string {
	for (const entry of currentTaskEntries(branch).entries) {
		if (entry.type === "custom_message" && entry.customType === "advisor-brief") {
			return typeof entry.content === "string" ? entry.content : "";
		}
	}
	return "";
}

/** Reason to escalate to the stronger escalation advisor, if any. */
function escalationTriggered(branch: SessionEntry[], callsUsed: number): string | undefined {
	if (judgeFailuresThisTask(branch) > 0) return "completion judge failure this task";
	for (const entry of currentTaskEntries(branch).entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = message.details as Partial<AdvisorDetails> | undefined;
		if (details?.kind !== "advisor") continue;
		const stopLine = messageText(message as { content: unknown }).match(/^\s*[-*]?\s*STOP\s*:?\s*(.*)$/m);
		if (stopLine && !/^(no\b|none\b|n\/a|not needed|continue)/i.test(stopLine[1].trim())) {
			return "prior advisor STOP advice this task";
		}
	}
	if (callsUsed >= 2) return "third or later advisor call this task";
	return undefined;
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
		`completion judge: ${config.judge}${config.judge !== "off" ? ` (max retries ${config.judgeMaxRetries})` : ""}`,
		`routing: ${config.routing.enabled ? `simple→${formatModel(config.routing.simple)} complex→${formatModel(config.routing.complex)}` : "off"}`,
		`escalation advisor: ${config.escalation ? formatModel(config.escalation) : "off"}`,
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

	pi.registerCommand("advisor-judge", {
		description: "Set advisor completion judge mode (verdict + retry on FAIL): /advisor-judge <off|auto|always> [retries:<n>]",
		handler: async (args, ctx) => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (!tokens.length) {
				ctx.ui.notify(`Advisor judge: ${config.judge} (max retries ${config.judgeMaxRetries})`, "info");
				return;
			}
			let mode: JudgeMode | undefined;
			let retries: number | undefined;
			for (const token of tokens) {
				const retryMatch = token.match(/^retries:(\d+)$/);
				if (retryMatch) retries = Number(retryMatch[1]);
				else if (token === "off" || token === "auto" || token === "always") mode = token;
				else {
					ctx.ui.notify("Usage: /advisor-judge <off|auto|always> [retries:<n>]", "error");
					return;
				}
			}
			persist({ ...config, judge: mode ?? config.judge, judgeMaxRetries: retries ?? config.judgeMaxRetries });
			updateStatus(ctx);
			ctx.ui.notify(`Advisor judge: ${config.judge} (max retries ${config.judgeMaxRetries})`, "info");
		},
	});

	pi.registerCommand("advisor-route", {
		description: "Route executor model per task complexity: /advisor-route simple:<model> complex:<model> | off",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(
					config.routing.enabled
						? `Routing: simple→${formatModel(config.routing.simple)} complex→${formatModel(config.routing.complex)}`
						: "Routing: off",
					"info",
				);
				return;
			}
			if (raw.toLowerCase() === "off") {
				persist({ ...config, routing: { ...config.routing, enabled: false } });
				updateStatus(ctx);
				ctx.ui.notify("Routing disabled", "info");
				return;
			}
			let simple = config.routing.simple;
			let complex = config.routing.complex;
			for (const token of raw.split(/\s+/).filter(Boolean)) {
				const match = token.match(/^(simple|complex):(.+)$/i);
				if (!match) {
					ctx.ui.notify("Usage: /advisor-route simple:<model> complex:<model> | off", "error");
					return;
				}
				const resolved = resolveModel(ctx, match[2]);
				if (!resolved.ok) {
					ctx.ui.notify(`${match[1]}: ${resolved.error}`, "error");
					return;
				}
				const ref = { provider: resolved.model.provider, model: resolved.model.id, spec: match[2] };
				if (match[1].toLowerCase() === "simple") simple = ref;
				else complex = ref;
			}
			if (!simple && !complex) {
				ctx.ui.notify("Usage: /advisor-route simple:<model> complex:<model> | off", "error");
				return;
			}
			persist({ ...config, routing: { enabled: true, simple, complex } });
			updateStatus(ctx);
			ctx.ui.notify(`Routing: simple→${formatModel(simple)} complex→${formatModel(complex)}`, "info");
		},
	});

	pi.registerCommand("advisor-escalate", {
		description: "Set a stronger escalation advisor used after judge failures, STOP advice, or repeated consults: /advisor-escalate <model|off>",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(`Escalation advisor: ${config.escalation ? formatModel(config.escalation) : "off"}`, "info");
				return;
			}
			if (raw.toLowerCase() === "off") {
				persist({ ...config, escalation: undefined });
				updateStatus(ctx);
				ctx.ui.notify("Escalation advisor disabled", "info");
				return;
			}
			const resolved = resolveModel(ctx, raw);
			if (!resolved.ok) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			persist({ ...config, escalation: { provider: resolved.model.provider, model: resolved.model.id, spec: raw } });
			updateStatus(ctx);
			ctx.ui.notify(`Escalation advisor: ${formatModel(config.escalation)}`, "info");
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
		const prompt = event.prompt ?? "";
		let executorLabel = ctx.model ? modelLabel(ctx.model) : "unknown";

		if (config.routing.enabled && prompt.trim()) {
			const complex = classifyTask(prompt).required;
			const target = complex ? config.routing.complex : config.routing.simple;
			if (target && (!ctx.model || ctx.model.provider !== target.provider || ctx.model.id !== target.model)) {
				const model = ctx.modelRegistry.find(target.provider, target.model);
				if (model && (await pi.setModel(model))) {
					executorLabel = modelLabel(model);
					if (ctx.hasUI) ctx.ui.notify(`Routed ${complex ? "complex" : "simple"} task to ${executorLabel}`, "info");
				} else if (ctx.hasUI) {
					ctx.ui.notify(`Routing skipped: cannot switch to ${formatModel(target)}`, "warning");
				}
			}
		}

		const wantBrief = config.brief === "always" || (config.brief === "auto" && briefWorthy(prompt));
		if (!wantBrief) return { systemPrompt };

		if (ctx.hasUI) ctx.ui.notify(`Advisor brief: consulting ${formatModel(config.advisor)}...`, "info");
		const diff = await gitContext(pi, ctx.cwd, 8000);
		const brief = await generateBrief(prompt, config, ctx, { executorLabel, diff });
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

	pi.on("agent_end", async (event, ctx) => {
		if (!config.enabled || !config.advisor || config.judge === "off") return;
		const last = event.messages[event.messages.length - 1] as { stopReason?: string } | undefined;
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const branch = ctx.sessionManager.getBranch();
		const { entries, prompt } = currentTaskEntries(branch);
		if (!entries.length || !prompt) return;
		if (config.judge === "auto" && !classifyTask(prompt).required) return;

		const priorFailures = judgeFailuresThisTask(branch);
		const useEscalation = priorFailures > 0 && config.escalation ? config.escalation : config.advisor;

		const messages = branch.map(entryToMessage).filter((message) => message !== undefined);
		const serialized = serializeConversation(convertToLlm(messages));
		const truncated = truncateTranscript(serialized, config.maxTranscriptChars);
		const diff = await gitContext(pi, ctx.cwd, 20_000);
		const brief = briefContentThisTask(branch);
		const judgePrompt = [
			`<user_request>\n${prompt}\n</user_request>`,
			brief ? `<execution_brief>\n${brief}\n</execution_brief>` : "",
			diff ? `<workspace_diff>\n${diff}\n</workspace_diff>` : "",
			`<transcript>\n${truncated.text}\n</transcript>`,
			`Judge the executor's finished attempt now. Keep it under ${config.maxWords * 2} words.`,
		]
			.filter(Boolean)
			.join("\n\n");

		if (ctx.hasUI) ctx.ui.notify(`Advisor judge: consulting ${formatModel(useEscalation)}...`, "info");
		const result = await consultModel(useEscalation, config, ctx, {
			system: JUDGE_SYSTEM,
			prompt: judgePrompt,
			timeoutMs: config.briefTimeoutMs,
		});
		if (!result.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Advisor judge skipped: ${result.error}`, "warning");
			return;
		}

		const verdict = /^\s*VERDICT:\s*PASS\b/im.test(result.text) ? "PASS" : "FAIL";
		appendGateLog({
			event: "judge_result",
			cwd: ctx.cwd,
			verdict,
			contentPreview: result.text.slice(0, 800),
			advisorProvider: useEscalation.provider,
			advisorModel: useEscalation.model,
			costTotal: result.usage?.cost,
		});

		if (verdict === "PASS") {
			if (ctx.hasUI) ctx.ui.notify("Advisor judge: PASS", "info");
			return;
		}
		if (priorFailures >= config.judgeMaxRetries) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Advisor judge: FAIL after ${priorFailures} retr${priorFailures === 1 ? "y" : "ies"}; stopping. ${result.text.slice(0, 200)}`, "warning");
			}
			return;
		}
		pi.sendMessage(
			{
				customType: "advisor-judge",
				content: `<advisor_judge verdict="FAIL" advisor="${formatModel(useEscalation)}">\n${result.text}\n</advisor_judge>\n\nThe completion judge found the task incomplete. Address REQUIRED_FIXES with concrete tool actions, verify each fix, then finish. Retry ${priorFailures + 1}/${config.judgeMaxRetries}.`,
				display: true,
				details: { kind: "judge", verdict, version: VERSION, advisor: useEscalation, usage: result.usage },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
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

			let advisorRef = config.advisor;
			let escalated: string | undefined;
			if (config.escalation) {
				escalated = escalationTriggered(branch, callsUsed);
				if (escalated) advisorRef = config.escalation;
			}

			onUpdate?.({
				content: [{ type: "text", text: `Consulting ${formatModel(advisorRef)}${escalated ? ` (escalated: ${escalated})` : ""}...` }],
				details: undefined,
			});

			const messages = branch.map(entryToMessage).filter((message) => message !== undefined);
			const llmMessages = convertToLlm(messages);
			const serialized = serializeConversation(llmMessages);
			const truncated = truncateTranscript(serialized, config.maxTranscriptChars);
			const focus = typeof params.focus === "string" ? params.focus.trim().slice(0, 2000) : "";
			const diff = await gitContext(pi, ctx.cwd, 20_000);

			const advisorPrompt = `<executor_context>\nExecutor model: ${ctx.model ? modelLabel(ctx.model) : "unknown"}\nWorking directory: ${ctx.cwd}\nAdvisor call: ${callsUsed + 1}/${config.maxUsesPerTask}\nRecommended re-consult cadence: ${config.advisorCadence > 0 ? `~${config.advisorCadence} meaningful executor observations` : "off"}\nTranscript truncated: ${truncated.truncated ? "yes" : "no"}\n</executor_context>\n${focus ? `\n<executor_focus>\n${focus}\n</executor_focus>\n` : ""}${diff ? `\n<workspace_diff>\n${diff}\n</workspace_diff>\n` : ""}\n<transcript>\n${truncated.text}\n</transcript>\n\nGive private guidance to the executor now. Keep it under ${config.maxWords} words. Be concrete, evidence-grounded, and verifier-oriented when the transcript contains an initial attempt or tool observations. When a workspace diff is present, critique the actual changes, not just the narrated ones.${focus ? " Address the executor's focus question first, then verify the broader trajectory." : ""}`;

			const result = await consultModel(advisorRef, config, ctx, { system: ADVISOR_SYSTEM, prompt: advisorPrompt, signal });
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Advisor error: ${result.error}. Continue without advice or ask user to adjust advisor config.` }],
					details: { kind: "error", version: VERSION, advisor: advisorRef, callsUsed: callsUsed + 1, maxUsesPerTask: config.maxUsesPerTask, truncatedTranscript: truncated.truncated, escalated, error: result.error } satisfies AdvisorDetails,
				};
			}

			return {
				content: [{ type: "text", text: result.text }],
				details: {
					kind: "advisor",
					version: VERSION,
					advisor: advisorRef,
					usage: result.usage,
					callsUsed: callsUsed + 1,
					maxUsesPerTask: config.maxUsesPerTask,
					truncatedTranscript: truncated.truncated,
					focus: focus || undefined,
					escalated,
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
			if (details?.escalated) out += theme.fg("warning", " escalated");
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

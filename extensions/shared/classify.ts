/**
 * Shared task classification used by the advisor and advisor-gate extensions.
 */

export interface TaskClassification {
	required: boolean;
	reasons: string[];
}

const CHECKS: Array<[RegExp, string]> = [
	[/(build|implement|create|write|add|modify|refactor|rewrite|migrate|upgrade|integrate)/, "implementation or code change"],
	[/(fix|debug|diagnose|failing|broken|regression|performance|bug)/, "debugging or regression"],
	[/(architecture|design|security|auth|permission|policy|enforce|gate|production)/, "architecture/security/policy"],
	[/(database|schema|migration|postgres|sql|delete|destructive)/, "data/destructive-risk"],
	[/(extension|provider|tool|agent|executor|advisor|model|habitat|absurd)/, "agent/tooling infrastructure"],
];

/** Classify a user prompt as advisor-worthy ("required") with human-readable reasons. */
export function classifyTask(prompt: string): TaskClassification {
	const p = prompt.toLowerCase();
	const reasons: string[] = [];
	for (const [re, reason] of CHECKS) if (re.test(p)) reasons.push(reason);
	if (prompt.length > 500) reasons.push("large/ambiguous request");
	return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** Whether a prompt is complex enough to justify an advisor-generated execution brief. */
export function briefWorthy(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.length >= 240) return true;
	return trimmed.length >= 40 && classifyTask(trimmed).required;
}

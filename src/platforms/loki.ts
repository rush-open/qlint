import {
	type BuildInput,
	type PlatformAdapter,
	type ValidateResult,
	registerAdapter,
} from "../platform.js";

/**
 * Grafana Loki (LogQL) adapter.
 *
 * Loki has a fundamentally different query model from other platforms:
 *   1. Stream selector (mandatory): {label="value", ...}
 *   2. Filter pipeline (optional):  | filter expressions
 *
 * Syntax:
 *   {service="payment"}                           stream selector
 *   {service="payment"} |= "error"                line contains
 *   {service="payment"} != "debug"                 line not contains
 *   {service="payment"} |~ "error|warn"            line regex match
 *   {service="payment"} !~ "debug|trace"           line regex not match
 *   {service="payment"} | json                     parse JSON fields
 *   {service="payment"} | json | level="error"     filter parsed fields
 *   {service="payment"} | json | latency > 500     comparison on parsed
 *   {service="payment"} | json | level=~"err.*"    regex on parsed field
 *
 * Stream selector labels:
 *   =   exact match
 *   !=  not equal
 *   =~  regex match
 *   !~  regex not match
 *
 * Build strategy:
 *   - First filter with a "service" or "app" field → stream selector label
 *   - Remaining filters → | json | field=value pipeline
 *   - Fulltext → |= "text" line filter
 */

const STREAM_SELECTOR_FIELDS = new Set([
	"service",
	"namespace",
	"app",
	"job",
	"instance",
	"env",
	"cluster",
	"container",
	"pod",
	"node",
]);

// ── Build ──

function escapeLabel(value: string): string {
	return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function build(input: BuildInput): string {
	const streamLabels: string[] = [];
	const pipelineFilters: string[] = [];
	let needsJson = false;

	for (const filter of input.filters) {
		const { field, op, value } = filter;
		const strVal = String(value);

		// Stream selector labels
		if (STREAM_SELECTOR_FIELDS.has(field) && (op === "=" || op === "!=")) {
			const lokiOp = op === "=" ? "=" : "!=";
			streamLabels.push(`${field}${lokiOp}${escapeLabel(strVal)}`);
			continue;
		}

		if (STREAM_SELECTOR_FIELDS.has(field) && (op === "regex" || op === "not_regex")) {
			const lokiOp = op === "regex" ? "=~" : "!~";
			streamLabels.push(`${field}${lokiOp}${escapeLabel(strVal)}`);
			continue;
		}

		// Everything else goes to pipeline (requires json parsing)
		needsJson = true;

		if (op === "in" || op === "not_in") {
			const values = Array.isArray(value) ? value : [strVal];
			const regex = values.map((v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
			const lokiOp = op === "in" ? "=~" : "!~";
			pipelineFilters.push(`${field}${lokiOp}${escapeLabel(`^(${regex})$`)}`);
			continue;
		}

		if (op === "regex" || op === "not_regex") {
			const lokiOp = op === "regex" ? "=~" : "!~";
			pipelineFilters.push(`${field}${lokiOp}${escapeLabel(strVal)}`);
			continue;
		}

		if (op === "!=") {
			pipelineFilters.push(`${field}!=${escapeLabel(strVal)}`);
			continue;
		}

		const compOps: Record<string, string> = { ">": ">", "<": "<", ">=": ">=", "<=": "<=" };
		const compOp = compOps[op];
		if (compOp) {
			pipelineFilters.push(`${field} ${compOp} ${strVal}`);
			continue;
		}

		if (op === "=") {
			pipelineFilters.push(`${field}=${escapeLabel(strVal)}`);
			continue;
		}

		throw new Error(
			`Unsupported operator "${op}" for Loki. Valid: =, !=, >, <, >=, <=, in, not_in, regex, not_regex`,
		);
	}

	// Build stream selector
	if (streamLabels.length === 0) {
		streamLabels.push('job=~".+"'); // match all — Loki requires at least one label
	}
	const selector = `{${streamLabels.join(", ")}}`;

	// Build pipeline
	const parts: string[] = [selector];

	// Fulltext → line filter
	if (input.fulltext) {
		parts.push(`|= ${escapeLabel(input.fulltext)}`);
	}

	// JSON parser if needed
	if (needsJson && pipelineFilters.length > 0) {
		parts.push("| json");
	}

	// Field filters
	for (const f of pipelineFilters) {
		parts.push(`| ${f}`);
	}

	return parts.join(" ");
}

// ── Validate ──

function validate(ql: string): ValidateResult {
	const trimmed = ql.trim();
	if (trimmed === "") {
		return { valid: false, errors: ["Empty query"] };
	}

	const errors: string[] = [];

	// Must start with { (stream selector)
	if (!trimmed.startsWith("{")) {
		errors.push('Loki queries must start with a stream selector: {label="value"}');
	}

	// Check balanced braces
	let braceDepth = 0;
	let inString = false;
	let strChar = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (inString) {
			if (ch === "\\" && i + 1 < trimmed.length) {
				i++;
				continue;
			}
			if (ch === strChar) inString = false;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			strChar = ch;
			continue;
		}
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;
		if (braceDepth < 0) {
			errors.push("Unexpected '}'");
			break;
		}
	}
	if (inString) {
		errors.push("Unterminated string literal");
	}
	if (braceDepth > 0) {
		errors.push("Unclosed '{'");
	}

	// Check stream selector has at least one label
	const selectorMatch = trimmed.match(/^\{([^}]*)\}/);
	if (selectorMatch) {
		const selectorBody = selectorMatch[1]!.trim();
		if (selectorBody === "") {
			errors.push("Empty stream selector — must have at least one label matcher");
		}

		// Check label matchers have valid operators
		// Split by comma, each should be label<op>"value"
		if (selectorBody !== "") {
			const labelParts = selectorBody.split(",").map((s) => s.trim());
			for (const lp of labelParts) {
				if (lp === "") continue;
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*(=~|!~|!=|=)/.test(lp)) {
					errors.push(`Invalid label matcher: "${lp}". Expected: label="value" or label=~"regex"`);
				}
			}
		}
	}

	// Check pipeline stages are prefixed with |
	const afterSelector = selectorMatch ? trimmed.substring(selectorMatch[0].length).trim() : "";
	if (afterSelector.length > 0) {
		// Pipeline should start with | or != (line not contains) or !~ (line regex not match)
		if (!afterSelector.startsWith("|") && !afterSelector.startsWith("!=") && !afterSelector.startsWith("!~")) {
			errors.push('Pipeline must start with "|", "!=" or "!~"');
		}

		// Check for empty pipeline stage: | |
		if (/\|\s*\|/.test(afterSelector)) {
			// Could be valid (e.g. |= "x" |= "y"), but | | (empty) is not
			// More precisely, check for | followed by | without content
			const stages = afterSelector.split("|").slice(1); // drop first empty
			for (let i = 0; i < stages.length; i++) {
				if (stages[i]!.trim() === "") {
					errors.push("Empty pipeline stage");
					break;
				}
			}
		}

		// Trailing pipe
		if (/\|\s*$/.test(afterSelector)) {
			errors.push("Incomplete pipeline: trailing '|'");
		}
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ── Register ──

const lokiAdapter: PlatformAdapter = {
	name: "loki",
	displayName: "Grafana Loki (LogQL)",
	validate,
	build,
};

registerAdapter(lokiAdapter);

export { lokiAdapter };

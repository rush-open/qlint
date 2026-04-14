import {
	type BuildInput,
	type PlatformAdapter,
	type ValidateResult,
	registerAdapter,
} from "../platform.js";

/**
 * Datadog Log Search Syntax adapter.
 *
 * Syntax:
 *   field:value                     standard field (service, host, status, etc.)
 *   @field:value                    facet/custom field (@ prefix)
 *   @field:>500  @field:>=500       comparison on facets
 *   -field:value                    negation (- prefix, no NOT keyword)
 *   field:(a OR b)                  multi-value (no 'in' keyword)
 *   "fulltext search"               phrase search
 *   field:pattern*                  wildcard
 *   space = AND (implicit)          terms separated by space are ANDed
 *   OR                              explicit OR (must be uppercase)
 *
 * Standard fields (no @ prefix): service, host, status, source, env,
 *   trace_id, message, @msg, timestamp
 */

const STANDARD_FIELDS = new Set([
	"service",
	"host",
	"status",
	"source",
	"env",
	"trace_id",
	"message",
	"timestamp",
	"version",
	"container_id",
	"container_name",
	"filename",
]);

// ── Build ──

function escapeValue(value: string): string {
	if (/[\s(),"\\]/.test(value) || value === "") {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

function fieldPrefix(field: string): string {
	// Standard fields don't need @, custom/facet fields do
	if (STANDARD_FIELDS.has(field)) return field;
	if (field.startsWith("@")) return field;
	return `@${field}`;
}

function buildCondition(filter: BuildInput["filters"][number]): string {
	const { field, op, value } = filter;

	if (op === "in" || op === "not_in") {
		const values = Array.isArray(value) ? value : [String(value)];
		const valList = values.map((v) => escapeValue(String(v))).join(" OR ");
		const prefix = op === "not_in" ? "-" : "";
		return `${prefix}${fieldPrefix(field)}:(${valList})`;
	}

	if (op === "regex" || op === "not_regex") {
		// Datadog doesn't have regex in search syntax — use wildcard
		throw new Error(
			`"regex" operator is not supported in Datadog log search. Use wildcard instead: ${fieldPrefix(field)}:${String(value).replace(/\.\*$/, "*")}`,
		);
	}

	if (op === "!=") {
		return `-${fieldPrefix(field)}:${escapeValue(String(value))}`;
	}

	// Comparison operators
	const compMap: Record<string, string> = {
		">": ":>",
		"<": ":<",
		">=": ":>=",
		"<=": ":<=",
	};
	const compOp = compMap[op];
	if (compOp) {
		return `${fieldPrefix(field)}${compOp}${escapeValue(String(value))}`;
	}

	if (op === "=") {
		return `${fieldPrefix(field)}:${escapeValue(String(value))}`;
	}

	throw new Error(
		`Unsupported operator "${op}" for Datadog. Valid: =, !=, >, <, >=, <=, in, not_in`,
	);
}

function build(input: BuildInput): string {
	const parts: string[] = [];

	if (input.fulltext) {
		parts.push(escapeValue(input.fulltext));
	}

	for (const filter of input.filters) {
		parts.push(buildCondition(filter));
	}

	// Datadog uses space as implicit AND
	return parts.join(" ");
}

// ── Validate ──

type Token = {
	type: "field-value" | "negated" | "string" | "keyword" | "paren" | "bare";
	value: string;
};

function tokenize(ql: string): { tokens: Token[]; errors: string[] } {
	const tokens: Token[] = [];
	const errors: string[] = [];
	let i = 0;

	while (i < ql.length) {
		if (/\s/.test(ql[i]!)) {
			i++;
			continue;
		}

		// String literals
		if (ql[i] === '"') {
			let j = i + 1;
			while (j < ql.length) {
				if (ql[j] === "\\" && j + 1 < ql.length) {
					j += 2;
					continue;
				}
				if (ql[j] === '"') break;
				j++;
			}
			if (j >= ql.length) {
				errors.push("Unterminated string literal");
				return { tokens, errors };
			}
			tokens.push({ type: "string", value: ql.substring(i, j + 1) });
			i = j + 1;
			continue;
		}

		// Parentheses
		if (ql[i] === "(" || ql[i] === ")") {
			tokens.push({ type: "paren", value: ql[i]! });
			i++;
			continue;
		}

		// Negation prefix: -field:value
		if (ql[i] === "-" && i + 1 < ql.length && /[a-zA-Z@]/.test(ql[i + 1]!)) {
			const rest = ql.substring(i + 1);
			const match = rest.match(/^[@a-zA-Z0-9_.]+/);
			if (match) {
				// Check if followed by colon
				const afterField = i + 1 + match[0]!.length;
				if (afterField < ql.length && ql[afterField] === ":") {
					// It's -field:... — consume until whitespace or paren
					let j = afterField + 1;
					if (j < ql.length && ql[j] === "(") {
						// -field:(a OR b)
						let depth = 1;
						j++;
						while (j < ql.length && depth > 0) {
							if (ql[j] === "(") depth++;
							if (ql[j] === ")") depth--;
							j++;
						}
						if (depth > 0) {
							errors.push(`Unclosed parenthesis (${depth} open)`);
						}
					} else if (j < ql.length && ql[j] === '"') {
						// -field:"value"
						j++;
						while (j < ql.length && ql[j] !== '"') {
							if (ql[j] === "\\") j++;
							j++;
						}
						j++; // past closing quote
					} else {
						while (j < ql.length && /[^\s()]/.test(ql[j]!)) j++;
					}
					tokens.push({ type: "negated", value: ql.substring(i, j) });
					i = j;
					continue;
				}
			}
		}

		// field:value or @field:value
		const fvMatch = ql.substring(i).match(/^@?[a-zA-Z0-9_.]+:/);
		if (fvMatch) {
			let j = i + fvMatch[0]!.length;
			// Consume value
			if (j < ql.length && ql[j] === "(") {
				let depth = 1;
				j++;
				while (j < ql.length && depth > 0) {
					if (ql[j] === "(") depth++;
					if (ql[j] === ")") depth--;
					j++;
				}
				if (depth > 0) {
					errors.push(`Unclosed parenthesis (${depth} open)`);
				}
			} else if (j < ql.length && ql[j] === '"') {
				j++;
				while (j < ql.length && ql[j] !== '"') {
					if (ql[j] === "\\") j++;
					j++;
				}
				j++;
			} else if (j < ql.length && ql[j] === "[") {
				// Range: [a TO b]
				while (j < ql.length && ql[j] !== "]") j++;
				j++;
			} else {
				while (j < ql.length && /[^\s()]/.test(ql[j]!)) j++;
			}
			tokens.push({ type: "field-value", value: ql.substring(i, j) });
			i = j;
			continue;
		}

		// Keywords: OR (AND is implicit via space)
		const wordMatch = ql.substring(i).match(/^[a-zA-Z0-9_.@*?-]+/);
		if (wordMatch) {
			const word = wordMatch[0]!;
			if (word === "OR" || word === "AND" || word === "NOT") {
				tokens.push({ type: "keyword", value: word });
			} else {
				tokens.push({ type: "bare", value: word });
			}
			i += word.length;
			continue;
		}

		i++;
	}
	return { tokens, errors };
}

function validate(ql: string): ValidateResult {
	const trimmed = ql.trim();
	if (trimmed === "") {
		return { valid: false, errors: ["Empty query"] };
	}

	const { tokens, errors } = tokenize(trimmed);

	// Check balanced parentheses
	let parenDepth = 0;
	for (const t of tokens) {
		if (t.type === "paren" && t.value === "(") parenDepth++;
		if (t.type === "paren" && t.value === ")") parenDepth--;
		if (parenDepth < 0) {
			errors.push("Unexpected ')'");
			break;
		}
	}
	if (parenDepth > 0) {
		errors.push(`Unclosed parenthesis (${parenDepth} open)`);
	}

	// Check trailing keyword
	const last = tokens[tokens.length - 1];
	if (last?.type === "keyword" && (last.value === "OR" || last.value === "AND" || last.value === "NOT")) {
		errors.push(`Incomplete expression: trailing "${last.value}"`);
	}

	// Check field:value has a value after colon
	for (const t of tokens) {
		if (t.type === "field-value" && t.value.endsWith(":")) {
			errors.push(`Missing value after ':' in "${t.value}"`);
		}
	}

	// Check consecutive OR OR
	for (let i = 0; i < tokens.length - 1; i++) {
		const t1 = tokens[i]!;
		const t2 = tokens[i + 1]!;
		if (t1.type === "keyword" && t2.type === "keyword" && t1.value === "OR" && t2.value === "OR") {
			errors.push("Consecutive OR operators");
			break;
		}
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ── Register ──

const datadogAdapter: PlatformAdapter = {
	name: "datadog",
	displayName: "Datadog Log Search",
	validate,
	build,
};

registerAdapter(datadogAdapter);

export { datadogAdapter };

import {
	type BuildInput,
	type PlatformAdapter,
	type ValidateResult,
	registerAdapter,
} from "../platform.js";

/**
 * Alibaba Cloud SLS (Simple Log Service) adapter.
 *
 * Syntax (close to Lucene with some differences):
 *   field: value                    equality (space after colon)
 *   field > 500                     comparison (space around operator)
 *   field: value and field: value   logical AND (lowercase)
 *   field: value or field: value    logical OR (lowercase)
 *   not field: value                negation (lowercase)
 *   field in (a, b, c)             multi-value
 *   "fulltext search"               phrase search
 *   field: value*                   wildcard (right-truncation only)
 *   ( ) for grouping               parentheses
 *
 * Key differences from Octopus:
 *   - Operators are lowercase: and, or, not (not AND/OR/NOT)
 *   - Colon separates field and value with optional space: field: value
 *   - Comparison operators have spaces: field > 500 (not field>500)
 */

// ── Build ──

function escapeValue(value: string): string {
	// SLS special chars: \ " ( ) [ ] { } : = < > ! * ? & | ~ ^ /
	if (/[\s\\:"()[\]{}<>=!*?&|~^/,]/.test(value) || value === "") {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

function buildCondition(filter: BuildInput["filters"][number]): string {
	const { field, op, value } = filter;

	if (op === "in" || op === "not_in") {
		const values = Array.isArray(value) ? value : [String(value)];
		const valList = values.map((v) => escapeValue(String(v))).join(", ");
		const prefix = op === "not_in" ? "not " : "";
		return `${prefix}${field} in (${valList})`;
	}

	if (op === "regex" || op === "not_regex") {
		throw new Error(
			`"regex" operator is not directly supported in SLS query syntax. Use wildcard: ${field}: ${String(value).replace(/\.\*$/, "*")}`,
		);
	}

	if (op === "!=") {
		return `not ${field}: ${escapeValue(String(value))}`;
	}

	const compOps: Record<string, string> = {
		">": ">",
		"<": "<",
		">=": ">=",
		"<=": "<=",
	};
	const compOp = compOps[op];
	if (compOp) {
		return `${field} ${compOp} ${escapeValue(String(value))}`;
	}

	if (op === "=") {
		return `${field}: ${escapeValue(String(value))}`;
	}

	throw new Error(
		`Unsupported operator "${op}" for SLS. Valid: =, !=, >, <, >=, <=, in, not_in`,
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

	return parts.join(" and ");
}

// ── Validate ──

const KEYWORDS = new Set(["and", "or", "not", "in", "to"]);

type Token = {
	type: "ident" | "op" | "keyword" | "string" | "paren";
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
		if (ql[i] === '"' || ql[i] === "'") {
			const quote = ql[i]!;
			let j = i + 1;
			while (j < ql.length) {
				if (ql[j] === "\\" && j + 1 < ql.length) {
					j += 2;
					continue;
				}
				if (ql[j] === quote) break;
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

		// Comma (inside in-lists)
		if (ql[i] === ",") {
			i++;
			continue;
		}

		// Operators: :, >=, <=, >, <, =, !=
		if (/[:=!<>]/.test(ql[i]!)) {
			let op = ql[i]!;
			if (op === "!" && i + 1 < ql.length && ql[i + 1] === "=") {
				op = "!=";
			} else if ((op === ">" || op === "<") && i + 1 < ql.length && ql[i + 1] === "=") {
				op += "=";
			}
			tokens.push({ type: "op", value: op });
			i += op.length;
			continue;
		}

		// Identifiers and keywords
		const identMatch = ql.substring(i).match(/^[^\s:=!<>()",]+/);
		if (identMatch) {
			const word = identMatch[0]!;
			if (KEYWORDS.has(word.toLowerCase())) {
				tokens.push({ type: "keyword", value: word.toLowerCase() });
			} else {
				tokens.push({ type: "ident", value: word });
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

	// Balanced parentheses
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

	// Trailing keyword
	const last = tokens[tokens.length - 1];
	if (last?.type === "keyword" && (last.value === "and" || last.value === "or" || last.value === "not")) {
		errors.push(`Incomplete expression: trailing "${last.value}"`);
	}

	// Trailing operator
	if (last?.type === "op") {
		errors.push(`Missing value after operator "${last.value}"`);
	}

	// Consecutive logical operators
	for (let i = 0; i < tokens.length - 1; i++) {
		const t1 = tokens[i]!;
		const t2 = tokens[i + 1]!;
		if (
			t1.type === "keyword" &&
			t2.type === "keyword" &&
			(t1.value === "and" || t1.value === "or") &&
			(t2.value === "and" || t2.value === "or")
		) {
			errors.push(`Consecutive logical operators: "${t1.value} ${t2.value}"`);
			break;
		}
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ── Register ──

const slsAdapter: PlatformAdapter = {
	name: "sls",
	displayName: "Alibaba Cloud SLS (Simple Log Service)",
	validate,
	build,
};

registerAdapter(slsAdapter);

export { slsAdapter };

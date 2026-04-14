import {
	type BuildInput,
	type PlatformAdapter,
	type ValidateResult,
	registerAdapter,
} from "../platform.js";

/**
 * Elasticsearch / Kibana (Lucene Query Syntax) adapter.
 *
 * Syntax:
 *   field:value                         equality
 *   field:>500  field:>=500             comparison (colon before operator)
 *   field:<100  field:<=100
 *   NOT field:value                     negation (no != operator in Lucene)
 *   field:(a OR b OR c)                 multi-value (no 'in' keyword)
 *   "fulltext search"                   phrase search
 *   field:pattern*                      wildcard
 *   field:/regex/                       regexp (Lucene regex syntax)
 *   AND  OR  NOT  (parentheses)         logical operators
 */

// ── Build ──

function escapeValue(value: string): string {
	// Lucene special chars: + - = && || > < ! ( ) { } [ ] ^ " ~ * ? : \ /
	// Quote the value if it contains whitespace or special chars
	if (/[\s+\-=&|><!()\[\]{}^"~*?:\\/]/.test(value) || value === "") {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

function buildCondition(filter: BuildInput["filters"][number]): string {
	const { field, op, value } = filter;

	if (op === "in" || op === "not_in") {
		const values = Array.isArray(value) ? value : [String(value)];
		const valList = values.map((v) => escapeValue(String(v))).join(" OR ");
		const prefix = op === "not_in" ? "NOT " : "";
		return `${prefix}${field}:(${valList})`;
	}

	if (op === "regex" || op === "not_regex") {
		const prefix = op === "not_regex" ? "NOT " : "";
		return `${prefix}${field}:/${String(value)}/`;
	}

	if (op === "!=") {
		return `NOT ${field}:${escapeValue(String(value))}`;
	}

	// Comparison operators: Lucene uses field:>value syntax
	const compMap: Record<string, string> = {
		">": ":>",
		"<": ":<",
		">=": ":>=",
		"<=": ":<=",
	};
	const compOp = compMap[op];
	if (compOp) {
		return `${field}${compOp}${escapeValue(String(value))}`;
	}

	if (op === "=") {
		return `${field}:${escapeValue(String(value))}`;
	}

	throw new Error(
		`Unsupported operator "${op}" for Elasticsearch. Valid: =, !=, >, <, >=, <=, in, not_in, regex`,
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

	return parts.join(" AND ");
}

// ── Validate ──

const KEYWORDS = new Set(["and", "or", "not", "to"]);

type Token = {
	type: "ident" | "op" | "keyword" | "string" | "paren" | "regex";
	value: string;
};

function tokenize(ql: string): { tokens: Token[]; errors: string[] } {
	const tokens: Token[] = [];
	const errors: string[] = [];
	let i = 0;

	while (i < ql.length) {
		// Skip whitespace
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
				tokens.push({ type: "string", value: ql.substring(i) });
				return { tokens, errors };
			}
			tokens.push({ type: "string", value: ql.substring(i, j + 1) });
			i = j + 1;
			continue;
		}

		// Regex literals: /pattern/
		if (ql[i] === "/") {
			let j = i + 1;
			while (j < ql.length && ql[j] !== "/") {
				if (ql[j] === "\\" && j + 1 < ql.length) j++;
				j++;
			}
			if (j >= ql.length) {
				errors.push("Unterminated regex literal");
				tokens.push({ type: "regex", value: ql.substring(i) });
				return { tokens, errors };
			}
			tokens.push({ type: "regex", value: ql.substring(i, j + 1) });
			i = j + 1;
			continue;
		}

		// Parentheses
		if (ql[i] === "(" || ql[i] === ")") {
			tokens.push({ type: "paren", value: ql[i]! });
			i++;
			continue;
		}

		// Operators: >=, <=, >, <, :
		if (ql[i] === ":" || ql[i] === ">" || ql[i] === "<") {
			let op = ql[i]!;
			// :>=, :<=, :>, :<
			if (op === ":" && i + 1 < ql.length && /[><]/.test(ql[i + 1]!)) {
				op += ql[i + 1]!;
				if (i + 2 < ql.length && ql[i + 2] === "=") {
					op += "=";
				}
			} else if ((op === ">" || op === "<") && i + 1 < ql.length && ql[i + 1] === "=") {
				op += "=";
			}
			tokens.push({ type: "op", value: op });
			i += op.length;
			continue;
		}

		// Identifiers (field names, values, keywords)
		const identMatch = ql.substring(i).match(/^[^\s:()"/<>]+/);
		if (identMatch) {
			const word = identMatch[0]!;
			if (KEYWORDS.has(word.toLowerCase())) {
				tokens.push({ type: "keyword", value: word.toUpperCase() });
			} else {
				tokens.push({ type: "ident", value: word });
			}
			i += word.length;
			continue;
		}

		// Unknown character — skip
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

	// Check trailing logical operators
	const last = tokens[tokens.length - 1];
	if (last?.type === "keyword" && (last.value === "AND" || last.value === "OR" || last.value === "NOT")) {
		errors.push(`Incomplete expression: trailing "${last.value}"`);
	}

	// Check trailing colon (field: with no value)
	if (last?.type === "op" && last.value === ":") {
		errors.push("Missing value after ':'");
	}

	// Check consecutive logical operators
	for (let i = 0; i < tokens.length - 1; i++) {
		const t1 = tokens[i]!;
		const t2 = tokens[i + 1]!;
		if (
			t1.type === "keyword" &&
			t2.type === "keyword" &&
			t1.value !== "NOT" && // NOT AND is valid (NOT + AND/OR is weird but NOT + term is fine)
			(t1.value === "AND" || t1.value === "OR") &&
			(t2.value === "AND" || t2.value === "OR")
		) {
			errors.push(`Consecutive logical operators: "${t1.value} ${t2.value}"`);
			break;
		}
	}

	// Check adjacent idents without operator (outside parens)
	// In Lucene, "field value" without colon is ambiguous — could be two fulltext terms
	// which is actually valid in Lucene (implicit OR/AND). So we don't flag this.

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// ── Register ──

const elasticsearchAdapter: PlatformAdapter = {
	name: "elasticsearch",
	displayName: "Elasticsearch / Kibana (Lucene)",
	validate,
	build,
};

registerAdapter(elasticsearchAdapter);

export { elasticsearchAdapter };

import { describe, expect, it } from "vitest";
import "../src/platforms/datadog.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("datadog");

describe("datadog validate", () => {
	const valid = (q: string) => expect(adapter.validate(q)).toEqual({ valid: true });
	const invalid = (q: string) => expect(adapter.validate(q).valid).toBe(false);

	describe("basic field:value", () => {
		it("standard field", () => valid("service:payment"));
		it("facet field with @", () => valid("@latency:500"));
		it("comparison", () => valid("@latency:>500"));
		it("comparison >=", () => valid("@latency:>=500"));
		it("comparison <", () => valid("@duration:<100"));
	});

	describe("negation", () => {
		it("-field:value", () => valid("-status:error"));
		it("-@field:value", () => valid("-@latency:>500"));
	});

	describe("logical operators", () => {
		it("space = implicit AND", () => valid("service:payment status:error"));
		it("explicit OR", () => valid("service:payment OR service:order"));
		it("multiple terms", () => valid("service:payment status:error @latency:>500"));
	});

	describe("multi-value", () => {
		it("field:(a OR b)", () => valid("status:(ok OR error)"));
		it("field:(a OR b OR c)", () => valid("service:(payment OR order OR shipping)"));
		it("negated multi-value", () => valid("-status:(warn OR error)"));
	});

	describe("fulltext search", () => {
		it("quoted phrase", () => valid('"connection refused"'));
		it("bare word", () => valid("error"));
		it("phrase + field", () => valid('"timeout" service:payment'));
	});

	describe("wildcard", () => {
		it("trailing wildcard", () => valid("service:payment-*"));
		it("facet wildcard", () => valid("@http.url:*example*"));
	});

	describe("invalid queries", () => {
		it("empty", () => invalid(""));
		it("trailing OR", () => invalid("service:payment OR"));
		it("trailing AND", () => invalid("service:payment AND"));
		it("trailing NOT", () => invalid("service:payment NOT"));
		it("unclosed paren", () => invalid("status:(ok OR error"));
		it("extra close paren", () => invalid("service:payment)"));
		it("unterminated string", () => invalid('"hello'));
		it("consecutive OR OR", () => invalid("service:a OR OR service:b"));
		it("empty field value", () => invalid("service:"));
	});
});

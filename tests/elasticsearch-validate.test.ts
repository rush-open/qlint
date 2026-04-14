import { describe, expect, it } from "vitest";
import "../src/platforms/elasticsearch.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("elasticsearch");

describe("elasticsearch validate", () => {
	const valid = (q: string) => expect(adapter.validate(q)).toEqual({ valid: true });
	const invalid = (q: string) => expect(adapter.validate(q).valid).toBe(false);

	describe("basic field:value", () => {
		it("simple equality", () => valid("service:payment"));
		it("with spaces around colon", () => valid("service:payment AND level:error"));
		it("comparison >", () => valid("latency:>500"));
		it("comparison >=", () => valid("latency:>=500"));
		it("comparison <", () => valid("latency:<100"));
		it("comparison <=", () => valid("latency:<=100"));
	});

	describe("logical operators", () => {
		it("AND", () => valid("service:payment AND level:error"));
		it("OR", () => valid("service:payment OR service:order"));
		it("NOT", () => valid("NOT level:debug"));
		it("combined", () => valid("service:payment AND (level:error OR level:warn)"));
	});

	describe("parentheses", () => {
		it("simple parens", () => valid("(service:payment OR service:order)"));
		it("multi-value", () => valid("status:(200 OR 201 OR 204)"));
		it("nested", () => valid("((a:1 OR b:2) AND c:3)"));
		it("NOT + parens", () => valid("NOT (service:test AND level:debug)"));
	});

	describe("fulltext search", () => {
		it("quoted phrase", () => valid('"connection refused"'));
		it("phrase + AND", () => valid('"error" AND service:payment'));
		it("bare term", () => valid("error")); // Lucene allows bare terms
	});

	describe("special syntax", () => {
		it("wildcard", () => valid("service:costa-*"));
		it("regex", () => valid("service:/costa-.*/"));
		it("range", () => valid("status:[400 TO 500]")); // Lucene range
	});

	describe("invalid queries", () => {
		it("empty", () => invalid(""));
		it("trailing AND", () => invalid("service:payment AND"));
		it("trailing OR", () => invalid("service:payment OR"));
		it("trailing NOT", () => invalid("service:payment NOT"));
		it("unclosed paren", () => invalid("service:payment AND (level:error"));
		it("extra close paren", () => invalid("service:payment)"));
		it("unterminated string", () => invalid('"hello'));
		it("unterminated regex", () => invalid("service:/costa-.*"));
		it("consecutive AND AND", () => invalid("a:1 AND AND b:2"));
		it("consecutive OR OR", () => invalid("a:1 OR OR b:2"));
		it("trailing colon", () => invalid("service:"));
	});
});

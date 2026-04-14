import { describe, expect, it } from "vitest";
import "../src/platforms/sls.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("sls");

describe("sls validate", () => {
	const valid = (q: string) => expect(adapter.validate(q)).toEqual({ valid: true });
	const invalid = (q: string) => expect(adapter.validate(q).valid).toBe(false);

	it("simple field: value", () => valid("service: payment"));
	it("comparison", () => valid("latency > 500"));
	it("and", () => valid("service: payment and level: error"));
	it("or", () => valid("service: payment or service: order"));
	it("not", () => valid("not level: debug"));
	it("in", () => valid("status in (200, 201, 204)"));
	it("parentheses", () => valid("(service: a or service: b) and level: error"));
	it("fulltext", () => valid('"connection refused"'));
	it("wildcard", () => valid("service: costa-*"));

	it("empty", () => invalid(""));
	it("trailing and", () => invalid("service: a and"));
	it("trailing or", () => invalid("service: a or"));
	it("trailing operator", () => invalid("service:"));
	it("unclosed paren", () => invalid("(service: a and level: b"));
	it("unterminated string", () => invalid('"hello'));
	it("consecutive and and", () => invalid("a: 1 and and b: 2"));
});

describe("sls build", () => {
	it("equality → field: value", () => {
		expect(adapter.build({ filters: [{ field: "service", op: "=", value: "payment" }] })).toBe(
			"service: payment",
		);
	});

	it("not equal → not field: value", () => {
		expect(adapter.build({ filters: [{ field: "level", op: "!=", value: "debug" }] })).toBe(
			"not level: debug",
		);
	});

	it("comparison", () => {
		expect(adapter.build({ filters: [{ field: "latency", op: ">", value: 500 }] })).toBe(
			"latency > 500",
		);
	});

	it("in", () => {
		expect(
			adapter.build({ filters: [{ field: "status", op: "in", value: ["200", "201"] }] }),
		).toBe("status in (200, 201)");
	});

	it("multiple → joined with 'and'", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "level", op: "=", value: "error" },
				],
			}),
		).toBe("service: payment and level: error");
	});

	it("fulltext", () => {
		expect(adapter.build({ filters: [], fulltext: "timeout" })).toBe("timeout");
	});

	it("regex throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "f", op: "regex", value: ".*" }] }),
		).toThrow("regex");
	});

	it("unknown op throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "f", op: "~" as "=", value: "v" }] }),
		).toThrow("Unsupported operator");
	});
});

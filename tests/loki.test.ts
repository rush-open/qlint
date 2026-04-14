import { describe, expect, it } from "vitest";
import "../src/platforms/loki.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("loki");

describe("loki validate", () => {
	const valid = (q: string) => expect(adapter.validate(q)).toEqual({ valid: true });
	const invalid = (q: string) => expect(adapter.validate(q).valid).toBe(false);

	describe("stream selector", () => {
		it("simple label", () => valid('{service="payment"}'));
		it("multiple labels", () => valid('{service="payment", env="prod"}'));
		it("not equal", () => valid('{service!="test"}'));
		it("regex match", () => valid('{service=~"pay.*"}'));
		it("regex not match", () => valid('{service!~"test.*"}'));
	});

	describe("pipeline", () => {
		it("line contains", () => valid('{service="payment"} |= "error"'));
		it("line not contains", () => valid('{service="payment"} != "debug"'));
		it("line regex", () => valid('{service="payment"} |~ "error|warn"'));
		it("json parser", () => valid('{service="payment"} | json'));
		it("json + filter", () => valid('{service="payment"} | json | level="error"'));
		it("json + comparison", () => valid('{service="payment"} | json | latency > 500'));
		it("multiple stages", () => valid('{app="web"} |= "error" | json | status >= 400'));
	});

	describe("invalid", () => {
		it("empty", () => invalid(""));
		it("no stream selector", () => invalid('level="error"'));
		it("empty selector", () => invalid("{}"));
		it("unclosed brace", () => invalid('{service="payment"'));
		it("unterminated string", () => invalid('{service="payment}'));
		it("trailing pipe", () => invalid('{service="payment"} |'));
		it("empty pipeline stage", () => invalid('{service="payment"} | | json'));
	});
});

describe("loki build", () => {
	it("stream selector from service field", () => {
		expect(adapter.build({ filters: [{ field: "service", op: "=", value: "payment" }] })).toBe(
			'{service="payment"}',
		);
	});

	it("stream selector != ", () => {
		expect(adapter.build({ filters: [{ field: "service", op: "!=", value: "test" }] })).toBe(
			'{service!="test"}',
		);
	});

	it("stream selector regex", () => {
		expect(
			adapter.build({ filters: [{ field: "service", op: "regex", value: "pay.*" }] }),
		).toBe('{service=~"pay.*"}');
	});

	it("non-stream field → json pipeline", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "level", op: "=", value: "error" },
				],
			}),
		).toBe('{service="payment"} | json | level="error"');
	});

	it("comparison in pipeline", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "latency", op: ">", value: 500 },
				],
			}),
		).toBe('{service="payment"} | json | latency > 500');
	});

	it("fulltext → line filter", () => {
		expect(
			adapter.build({
				filters: [{ field: "service", op: "=", value: "payment" }],
				fulltext: "error",
			}),
		).toBe('{service="payment"} |= "error"');
	});

	it("no stream fields → match-all selector", () => {
		expect(adapter.build({ filters: [{ field: "level", op: "=", value: "error" }] })).toBe(
			'{job=~".+"} | json | level="error"',
		);
	});

	it("multiple non-stream filters", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "level", op: "=", value: "error" },
					{ field: "latency", op: ">", value: 500 },
				],
			}),
		).toBe('{service="payment"} | json | level="error" | latency > 500');
	});

	it("in → regex pipeline", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "web" },
					{ field: "status", op: "in", value: ["400", "500"] },
				],
			}),
		).toBe('{service="web"} | json | status=~"^(400|500)$"');
	});

	it("unknown op throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "f", op: "~" as "=", value: "v" }] }),
		).toThrow("Unsupported operator");
	});
});

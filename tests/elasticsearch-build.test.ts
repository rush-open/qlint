import { describe, expect, it } from "vitest";
import "../src/platforms/elasticsearch.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("elasticsearch");

describe("elasticsearch build", () => {
	it("simple equality", () => {
		expect(adapter.build({ filters: [{ field: "service", op: "=", value: "payment" }] })).toBe(
			"service:payment",
		);
	});

	it("not equal → NOT field:value", () => {
		expect(adapter.build({ filters: [{ field: "level", op: "!=", value: "debug" }] })).toBe(
			"NOT level:debug",
		);
	});

	it("greater than → field:>value", () => {
		expect(adapter.build({ filters: [{ field: "latency", op: ">", value: 500 }] })).toBe(
			"latency:>500",
		);
	});

	it("less or equal → field:<=value", () => {
		expect(adapter.build({ filters: [{ field: "latency", op: "<=", value: 100 }] })).toBe(
			"latency:<=100",
		);
	});

	it("in → field:(a OR b)", () => {
		expect(
			adapter.build({ filters: [{ field: "status", op: "in", value: ["200", "201"] }] }),
		).toBe("status:(200 OR 201)");
	});

	it("not_in → NOT field:(a OR b)", () => {
		expect(
			adapter.build({ filters: [{ field: "status", op: "not_in", value: ["400", "500"] }] }),
		).toBe("NOT status:(400 OR 500)");
	});

	it("regex → field:/pattern/", () => {
		expect(
			adapter.build({ filters: [{ field: "service", op: "regex", value: "costa-.*" }] }),
		).toBe("service:/costa-.*/");
	});

	it("multiple filters joined with AND", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "level", op: "=", value: "error" },
				],
			}),
		).toBe("service:payment AND level:error");
	});

	it("fulltext search", () => {
		expect(adapter.build({ filters: [], fulltext: "connection refused" })).toBe(
			'"connection refused"',
		);
	});

	it("fulltext + filters", () => {
		expect(
			adapter.build({
				filters: [{ field: "service", op: "=", value: "payment" }],
				fulltext: "error",
			}),
		).toBe("error AND service:payment");
	});

	it("value with spaces gets quoted", () => {
		expect(
			adapter.build({ filters: [{ field: "msg", op: "=", value: "hello world" }] }),
		).toBe('msg:"hello world"');
	});

	it("unknown operator throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "f", op: "~" as "=", value: "v" }] }),
		).toThrow("Unsupported operator");
	});
});

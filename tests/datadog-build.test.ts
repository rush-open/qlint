import { describe, expect, it } from "vitest";
import "../src/platforms/datadog.js";
import { getAdapter } from "../src/platform.js";

const adapter = getAdapter("datadog");

describe("datadog build", () => {
	it("standard field equality", () => {
		expect(adapter.build({ filters: [{ field: "service", op: "=", value: "payment" }] })).toBe(
			"service:payment",
		);
	});

	it("custom field gets @ prefix", () => {
		expect(adapter.build({ filters: [{ field: "latency", op: "=", value: "500" }] })).toBe(
			"@latency:500",
		);
	});

	it("standard field no @ prefix", () => {
		expect(adapter.build({ filters: [{ field: "host", op: "=", value: "prod-1" }] })).toBe(
			"host:prod-1",
		);
	});

	it("not equal → -field:value", () => {
		expect(adapter.build({ filters: [{ field: "status", op: "!=", value: "ok" }] })).toBe(
			"-status:ok",
		);
	});

	it("greater than on facet", () => {
		expect(adapter.build({ filters: [{ field: "latency", op: ">", value: 500 }] })).toBe(
			"@latency:>500",
		);
	});

	it("in → field:(a OR b)", () => {
		expect(
			adapter.build({
				filters: [{ field: "service", op: "in", value: ["payment", "order"] }],
			}),
		).toBe("service:(payment OR order)");
	});

	it("not_in → -field:(a OR b)", () => {
		expect(
			adapter.build({
				filters: [{ field: "status", op: "not_in", value: ["warn", "error"] }],
			}),
		).toBe("-status:(warn OR error)");
	});

	it("regex throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "service", op: "regex", value: "pay.*" }] }),
		).toThrow("regex");
	});

	it("multiple filters joined by space (implicit AND)", () => {
		expect(
			adapter.build({
				filters: [
					{ field: "service", op: "=", value: "payment" },
					{ field: "status", op: "=", value: "error" },
					{ field: "latency", op: ">", value: 500 },
				],
			}),
		).toBe("service:payment status:error @latency:>500");
	});

	it("fulltext search", () => {
		expect(adapter.build({ filters: [], fulltext: "connection refused" })).toBe(
			'"connection refused"',
		);
	});

	it("fulltext + filters (space separated)", () => {
		expect(
			adapter.build({
				filters: [{ field: "service", op: "=", value: "payment" }],
				fulltext: "error",
			}),
		).toBe("error service:payment");
	});

	it("unknown operator throws", () => {
		expect(() =>
			adapter.build({ filters: [{ field: "f", op: "~" as "=", value: "v" }] }),
		).toThrow("Unsupported operator");
	});
});

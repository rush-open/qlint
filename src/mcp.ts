import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolvePlatform } from "./config.js";
import { getAdapter, listAdapters } from "./platform.js";

// Ensure adapters are registered
import "./platforms/octopus.js";
import "./platforms/elasticsearch.js";
import "./platforms/datadog.js";
import "./platforms/sls.js";
import "./platforms/loki.js";

export async function startMcpServer(): Promise<void> {
	const server = new Server(
		{ name: "qlint-mcp", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "qlint_validate",
				description:
					"Validate an observability query string for a specific platform. Returns { valid: boolean, errors?: string[] }.",
				inputSchema: {
					type: "object" as const,
					properties: {
						query: { type: "string", description: "The query string to validate" },
						platform: {
							type: "string",
							description: `Target platform. Available: ${listAdapters().map((a) => a.name).join(", ")}. Defaults to configured platform.`,
						},
					},
					required: ["query"],
				},
			},
			{
				name: "qlint_build",
				description:
					"Build a valid query string from structured filter conditions for the target platform.",
				inputSchema: {
					type: "object" as const,
					properties: {
						filters: {
							type: "array",
							items: {
								type: "object",
								properties: {
									field: { type: "string", description: "Field name" },
									op: {
										type: "string",
										enum: ["=", "!=", ">", "<", ">=", "<=", "in", "not_in"],
										description: "Comparison operator",
									},
									value: {
										description: "Value (string, number, or array of strings for 'in')",
									},
								},
								required: ["field", "op", "value"],
							},
							description: "Filter conditions",
						},
						timeRange: {
							type: "string",
							description: "Time range like 15m, 1h, 2d",
						},
						fulltext: {
							type: "string",
							description: "Full-text search term",
						},
						platform: {
							type: "string",
							description: "Target platform. Defaults to configured platform.",
						},
					},
					required: ["filters"],
				},
			},
			{
				name: "qlint_platforms",
				description: "List all supported observability platforms.",
				inputSchema: {
					type: "object" as const,
					properties: {},
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		switch (name) {
			case "qlint_validate": {
				const { query, platform: platformArg } = args as {
					query: string;
					platform?: string;
				};
				const platform = resolvePlatform(platformArg);
				if (!platform) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "No platform configured. Specify platform parameter.",
								}),
							},
						],
					};
				}
				const adapter = getAdapter(platform);
				const result = adapter.validate(query);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			}

			case "qlint_build": {
				const { filters, timeRange, fulltext, platform: platformArg } = args as {
					filters: Array<{ field: string; op: string; value: string | string[] }>;
					timeRange?: string;
					fulltext?: string;
					platform?: string;
				};
				const platform = resolvePlatform(platformArg);
				if (!platform) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "No platform configured. Specify platform parameter.",
								}),
							},
						],
					};
				}
				const adapter = getAdapter(platform);
				const query = adapter.build({
					filters: filters.map((f) => ({
						field: f.field,
						op: f.op as "=",
						value: f.value,
					})),
					timeRange,
					fulltext,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ query, platform }),
						},
					],
				};
			}

			case "qlint_platforms": {
				const platforms = listAdapters().map((a) => ({
					name: a.name,
					displayName: a.displayName,
				}));
				return {
					content: [{ type: "text" as const, text: JSON.stringify(platforms) }],
				};
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

import { Command } from "commander";
import { getGlobalConfig, requirePlatform, saveGlobalConfig } from "./config.js";
import { getAdapter, listAdapters } from "./platform.js";

// Register all available platform adapters
import "./platforms/octopus.js";
import "./platforms/elasticsearch.js";
import "./platforms/datadog.js";

function parseFilterArg(raw: string): { field: string; op: string; value: string } {
	const match = raw.match(/^(.+?)\s*(!=|>=|<=|>|<|=)\s*(.+)$/);
	if (!match) {
		throw new Error(`Invalid filter: "${raw}". Expected format: field=value, field>500, etc.`);
	}
	return { field: match[1]!, op: match[2]!, value: match[3]! };
}

const program = new Command();

program.name("qlint").version("0.1.0").description("Observability query linter for AI agents");

// qlint config -p <platform>
program
	.command("config")
	.description("Configure default platform")
	.requiredOption("-p, --platform <platform>", "Platform name")
	.action((opts: { platform: string }) => {
		const config = getGlobalConfig();
		config.platform = opts.platform;
		saveGlobalConfig(config);
		console.log(`Platform set to: ${opts.platform}`);
		console.log(`Saved to ~/.qlint/config.json`);
	});

// qlint validate <query>
program
	.command("validate")
	.description("Validate a query string")
	.argument("<query>", "Query string to validate")
	.option("-p, --platform <platform>", "Target platform")
	.action((query: string, opts: { platform?: string }) => {
		const platform = requirePlatform(opts.platform);
		const adapter = getAdapter(platform);
		const result = adapter.validate(query);
		console.log(JSON.stringify(result, null, 2));
		if (!result.valid) process.exit(1);
	});

// qlint build -f <filter> [-f <filter>...] [--timerange <duration>]
program
	.command("build")
	.description("Build a query from structured conditions")
	.option("-f, --filter <filter...>", 'Filter conditions (e.g. "service=payment", "latency>500")')
	.option("-t, --timerange <duration>", "Time range (e.g. 15m, 1h, 2d)")
	.option("--fulltext <text>", "Full-text search term")
	.option("-p, --platform <platform>", "Target platform")
	.action(
		(opts: {
			filter?: string[];
			timerange?: string;
			fulltext?: string;
			platform?: string;
		}) => {
			const platform = requirePlatform(opts.platform);
			const adapter = getAdapter(platform);
			const filters = (opts.filter ?? []).map((f) => {
				const parsed = parseFilterArg(f);
				return { field: parsed.field, op: parsed.op as "=", value: parsed.value };
			});
			const query = adapter.build({
				filters,
				timeRange: opts.timerange,
				fulltext: opts.fulltext,
			});
			console.log(query);
		},
	);

// qlint translate --from <platform> [--to <platform>] <query>
program
	.command("translate")
	.description("Translate a query between platforms")
	.argument("<query>", "Query string to translate")
	.requiredOption("--from <platform>", "Source platform")
	.option("--to <platform>", "Target platform (defaults to configured platform)")
	.action((query: string, opts: { from: string; to?: string }) => {
		const targetPlatform = requirePlatform(opts.to);
		const sourceAdapter = getAdapter(opts.from);
		const targetAdapter = getAdapter(targetPlatform);

		// Validate source first
		const validation = sourceAdapter.validate(query);
		if (!validation.valid) {
			console.error(JSON.stringify({ error: "Invalid source query", ...validation }));
			process.exit(1);
		}

		// For now, translate is only available when both adapters are registered
		// Full implementation will parse source → AST → serialize to target
		console.error(
			`Translation from ${sourceAdapter.name} to ${targetAdapter.name} not yet implemented`,
		);
		process.exit(1);
	});

// qlint platforms
program
	.command("platforms")
	.description("List supported platforms")
	.action(() => {
		const adapters = listAdapters();
		if (adapters.length === 0) {
			console.log("No platforms registered.");
			return;
		}
		for (const a of adapters) {
			console.log(`  ${a.name.padEnd(16)} ${a.displayName}`);
		}
	});

// qlint mcp
program
	.command("mcp")
	.description("Start MCP server (stdio)")
	.action(async () => {
		const { startMcpServer } = await import("./mcp.js");
		await startMcpServer();
	});

// qlint mcp-install
program
	.command("mcp-install")
	.description("Register qlint MCP with Claude Code")
	.option("-s, --scope <scope>", "Scope: user or project", "user")
	.action(async (opts: { scope: string }) => {
		const validScopes = new Set(["user", "project"]);
		if (!validScopes.has(opts.scope)) {
			console.error(`Invalid scope: "${opts.scope}". Must be "user" or "project".`);
			process.exit(1);
		}
		const { execFileSync } = await import("node:child_process");
		try {
			execFileSync("claude", ["mcp", "add", "qlint", "-s", opts.scope, "--", "npx", "-y", "qlint", "mcp"], {
				stdio: "inherit",
			});
			console.log("qlint MCP registered successfully.");
		} catch {
			console.error("Failed to register. Make sure `claude` CLI is installed.");
			process.exit(1);
		}
	});

program.parse();

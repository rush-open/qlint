<div align="center">

# qlint

**Observability query linter — helps AI agents generate correct queries for any observability platform**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Quick Start

```bash
# Configure your platform
npx qlint config -p octopus

# Validate a query
npx qlint validate "service = payment AND level = ERROR"

# Build a query from structured conditions
npx qlint build -f "service=payment" -f "level=ERROR" -f "latency>500"
```

## Features

- **Platform-aware validation** — catches syntax errors before they hit the API
- **Structured query building** — generate correct QL from field/op/value conditions, no string wrangling
- **Multi-platform** — Octopus, Elasticsearch, Datadog, and more (expanding)
- **MCP Server** — built-in tools for AI agent integration
- **SKILL.md** — teaches agents platform syntax so they write correct queries from the start
- **Bind once, use everywhere** — configure your platform once, all commands use it automatically

## Why

AI agents frequently generate observability queries with subtle syntax errors — wrong operators, missing quotes, unsupported features. These fail silently or return wrong results. qlint catches these issues before execution.

```
User: "payment 服务最近有报错吗？"
    ↓
Agent builds query → qlint validate → ✓ correct
    ↓
octo-cli / Datadog API executes → results back to user
```

## Installation

**Requirements:** Node.js >= 22.0.0

```bash
npx qlint <command>           # Use directly via npx
npm install -g qlint          # Or global install
```

## Configuration

Bind your platform once:

```bash
qlint config -p octopus       # or: elasticsearch, datadog
```

Saved to `~/.qlint/config.json`. Override per-project with `.qlint.json` in your repo root, or per-command with `-p <platform>`.

**Priority:** CLI flag `-p` > project `.qlint.json` > global `~/.qlint/config.json`

## Commands

| Command | Description |
|---------|-------------|
| `config -p <platform>` | Set default platform |
| `validate "<query>"` | Validate query syntax |
| `build -f "field=value" ...` | Build query from conditions |
| `translate --from <p> "<query>"` | Translate between platforms |
| `platforms` | List supported platforms |
| `mcp` | Start MCP stdio server |
| `mcp-install` | Register MCP with Claude Code |

## Usage Examples

### Validate

```bash
# Valid query
qlint validate "service = payment AND level = ERROR"
# → { "valid": true }

# Syntax error — clear message
qlint validate "service = payment AND"
# → { "valid": false, "errors": ["Incomplete expression: trailing \"AND\""] }

# Catches common mistakes
qlint validate "service == payment"
# → { "valid": false, "errors": ["Invalid operator \"==\". Use \"=\" for equality"] }

# Catches API-unsupported syntax
qlint validate 'service regexp "foo.*"'
# → { "valid": false, "errors": ["\"regexp\" is not supported by the Octopus API..."] }
```

### Build

Safer than hand-crafting query strings — handles quoting and escaping automatically:

```bash
qlint build -f "service=payment" -f "level=ERROR"
# → service=payment AND level=ERROR

qlint build -f "service=payment" -f "latency>500" -f "status!=200"
# → service=payment AND latency>500 AND status!=200

# Values with spaces are auto-quoted
qlint build -f "msg=hello world"
# → msg="hello world"

# Full-text search
qlint build --fulltext "connection refused" -f "service=payment"
# → "connection refused" AND service=payment
```

### Build + Execute (with octo-cli)

```bash
# Build query → pipe to octo-cli
QUERY=$(qlint build -f "service=payment" -f "level=ERROR")
octo-cli logs search -q "$QUERY" -l 15m

# Aggregation (use octo-cli flags, not pipeline syntax)
octo-cli logs aggregate -q "service = payment" -a "*:count" -g "level" -l 1h
```

## Platform Syntax Reference

### Octopus

```
service = payment AND level = ERROR     # field match
latency > 500                           # comparison
status in (400, 401, 500)               # multi-value
NOT level = DEBUG                       # negation
"connection refused"                    # fulltext search
service = costa-*                       # wildcard
(a = 1 OR b = 2) AND c = 3             # parentheses
k8s.container.name = http-server        # dotted field names
```

### Elasticsearch / Kibana

```
service:payment AND level:error         # field:value (colon, no =)
latency:>500                            # comparison
status:(400 OR 401 OR 500)              # multi-value
NOT level:debug                         # negation
"connection refused"                    # fulltext
host:prod-*                             # wildcard
```

### Datadog

```
service:payment status:error            # space = AND (implicit)
@latency:>500                           # @ prefix for custom fields
-status:ok                              # - prefix = NOT
service:(payment OR order)              # multi-value
```

## MCP Server

Built-in MCP server for AI agent integration (Claude Code, Cursor, etc.).

### Setup

```bash
# Auto-register with Claude Code
qlint mcp-install

# Or manual config
```

```json
{
  "mcpServers": {
    "qlint": {
      "command": "npx",
      "args": ["-y", "qlint", "mcp"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `qlint_validate` | Validate query syntax for a platform |
| `qlint_build` | Build query from structured filter conditions |
| `qlint_platforms` | List supported platforms |

## AI Agent Skill

Install as a [reskill](https://github.com/nicepkg/reskill) skill to teach AI agents platform query syntax:

```bash
npx reskill install github:open-rush/qlint/skills -a claude-code cursor -y
```

The skill provides:
- Per-platform syntax quick reference
- Query strategy (start broad, narrow down)
- Common error patterns and fixes
- octo-cli integration workflows

## Supported Platforms

| Platform | validate | build | Status |
|----------|----------|-------|--------|
| Octopus | ✅ | ✅ | Shipped — 200 production queries tested |
| Elasticsearch | Planned | Planned | Next |
| Datadog | Planned | Planned | Next |
| Alibaba SLS | Planned | Planned | — |
| Grafana Loki | Planned | Planned | — |

## Testing

```bash
npm test                       # 72 unit tests
node tests/backend-200.mjs     # 200 queries against live Octopus API
```

## License

MIT

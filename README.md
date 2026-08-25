# pi-xcode-mcp

A [Pi coding agent](https://pi.dev) extension that connects Pi to the MCP tool service built into Xcode through Apple's `xcrun mcpbridge`.

## Features

- Automatically connects when Xcode is running
- Lists and invokes the tools exposed by the open Xcode project
- Adds a compact Xcode tool catalog to Pi's system prompt while connected
- Supports MCP text, image, resource, structured, and progress results
- Propagates cancellation and enforces bounded timeouts/output
- Cleans up the bridge on reload, session replacement, and shutdown
- Provides TUI status plus connection-management commands

## Requirements

- macOS with an Xcode version that includes `xcrun mcpbridge`
- A project open in Xcode
- **Xcode > Settings > Intelligence > Model Context Protocol > Allow external agents to use Xcode tools** enabled
- Pi coding agent

Xcode displays an alert when an external agent connects.

## Install

From GitHub:

```bash
pi install git:github.com/zbagley99/pi-xcode-mcp
```

For a temporary test checkout:

```bash
pi --no-extensions -e ./extensions/xcode-mcp.ts
```

After installation, restart Pi or run `/reload`.

## Pi tool

The extension registers one model-callable tool named `xcode`:

| Action | Purpose |
| --- | --- |
| `connect` | Connect or reconnect and refresh the tool catalog |
| `status` | Report bridge state and diagnostics |
| `list` | Return Xcode MCP tool names, descriptions, and input schemas |
| `call` | Invoke an Xcode MCP tool by exact name |
| `disconnect` | Close the bridge process |

Models should use `list` before calling an unfamiliar Xcode tool.

## Commands

- `/xcode-connect`
- `/xcode-status`
- `/xcode-tools`
- `/xcode-disconnect`

## Example model flow

1. Call `xcode` with `{ "action": "list" }`.
2. Select the appropriate Xcode MCP capability and inspect its `inputSchema`.
3. Call `xcode` with:

```json
{
  "action": "call",
  "tool": "<exact MCP tool name>",
  "arguments": {
    "<schema field>": "<value>"
  }
}
```

## Troubleshooting

### `Tool provider not initialized` or request timeout

1. Make sure a project is open in Xcode.
2. Toggle **Allow external agents to use Xcode tools** off and on.
3. Restart Xcode if necessary.
4. Run `/xcode-connect` in Pi.

### Multiple Xcode processes

Set `MCP_XCODE_PID` before starting Pi to select a specific Xcode instance:

```bash
MCP_XCODE_PID=12345 pi
```

Otherwise, `mcpbridge` uses Xcode's normal auto-detection.

## Development

```bash
npm install --ignore-scripts
PI_SKIP_VERSION_CHECK=1 pi --no-extensions \
  -e ./extensions/xcode-mcp.ts \
  --list-models
```

Runtime dependencies belong in `dependencies`; Pi-provided extension APIs remain peer dependencies.

## Security

Pi extensions run with the user's full permissions. Xcode MCP tools may modify projects, build targets, run tests, or perform other IDE actions. Review the source and keep Xcode's external-agent permission disabled when not needed.

## License

MIT

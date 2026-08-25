import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const STDERR_CAP_BYTES = 16 * 1024;
const DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capTail(current: string, addition: string): string {
  const bytes = Buffer.from(current + addition, "utf8");
  if (bytes.length <= STDERR_CAP_BYTES) return bytes.toString("utf8");
  return bytes.subarray(bytes.length - STDERR_CAP_BYTES).toString("utf8");
}

function formatCatalog(tools: McpTool[], includeSchemas: boolean): string {
  if (tools.length === 0) return "Xcode reported no MCP tools.";
  if (includeSchemas) {
    return JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
      null,
      2,
    );
  }
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description ?? tool.title ?? "Xcode MCP tool"}`)
    .join("\n");
}

function truncateText(text: string): string {
  const result = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Output truncated: ${result.outputLines}/${result.totalLines} lines, ${result.outputBytes}/${result.totalBytes} bytes shown.]`;
}

function formatMcpResult(result: any): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  textForError: string;
  structuredContent?: Record<string, unknown>;
} {
  if (result && "toolResult" in result) {
    const text = truncateText(JSON.stringify(result.toolResult, null, 2));
    return { content: [{ type: "text", text }], textForError: text };
  }

  const textParts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const block of result?.content ?? []) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource") {
      if (typeof block.resource?.text === "string") {
        textParts.push(`[Resource: ${block.resource.uri}]\n${block.resource.text}`);
      } else {
        textParts.push(`[Binary resource: ${block.resource?.uri ?? "unknown"}]`);
      }
    } else if (block.type === "resource_link") {
      textParts.push(`[Resource link: ${block.name}] ${block.uri}`);
    } else if (block.type === "audio") {
      textParts.push(`[Audio result omitted from model context: ${block.mimeType}]`);
    } else {
      textParts.push(JSON.stringify(block, null, 2));
    }
  }

  if (result?.structuredContent && textParts.length === 0) {
    textParts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (textParts.length === 0 && images.length === 0) textParts.push("Xcode tool completed successfully.");

  const text = truncateText(textParts.join("\n\n"));
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  if (text) content.push({ type: "text", text });
  content.push(...images);
  return { content, textForError: text, structuredContent: result?.structuredContent };
}

function setupHint(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("no running xcode") ||
    lower.includes("tool provider not initialized") ||
    lower.includes("connection") ||
    lower.includes("timed out")
  ) {
    return `${message}\n\nOpen the project in Xcode, then enable Xcode > Settings > Intelligence > Model Context Protocol > Allow external agents to use Xcode tools. If it is already enabled, toggle it off/on or restart Xcode, then run /xcode-connect.`;
  }
  return message;
}

export default function (pi: ExtensionAPI) {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let state: ConnectionState = "disconnected";
  let catalog: McpTool[] = [];
  let lastError: string | undefined;
  let stderrTail = "";
  let connectPromise: Promise<void> | null = null;
  let shuttingDown = false;
  let currentCwd = process.cwd();
  let statusContext: any;

  const updateStatus = () => {
    if (!statusContext?.hasUI) return;
    if (state === "connected") {
      statusContext.ui.setStatus("xcode-mcp", `Xcode MCP: ${catalog.length} tools`);
    } else if (state === "connecting") {
      statusContext.ui.setStatus("xcode-mcp", "Xcode MCP: connecting");
    } else if (state === "error") {
      statusContext.ui.setStatus("xcode-mcp", "Xcode MCP: unavailable");
    } else {
      statusContext.ui.setStatus("xcode-mcp", "Xcode MCP: disconnected");
    }
  };

  const markDisconnected = (candidate?: Client) => {
    if (candidate && client !== candidate) return;
    client = null;
    transport = null;
    if (!shuttingDown && state !== "error") state = "disconnected";
    updateStatus();
  };

  const disconnect = async () => {
    const oldClient = client;
    const oldTransport = transport;
    client = null;
    transport = null;
    catalog = [];
    state = "disconnected";
    connectPromise = null;
    updateStatus();
    if (oldClient) await oldClient.close().catch(() => {});
    else if (oldTransport) await oldTransport.close().catch(() => {});
  };

  const connect = async (force = false) => {
    if (process.platform !== "darwin") throw new Error("The Xcode MCP bridge is available only on macOS.");
    if (state === "connected" && client && !force) return;
    if (connectPromise && !force) return connectPromise;
    if (force) await disconnect();

    state = "connecting";
    lastError = undefined;
    stderrTail = "";
    updateStatus();

    const attempt = async () => {
      let candidateClient: Client | null = null;
      let candidateTransport: StdioClientTransport | null = null;
      try {
        candidateTransport = new StdioClientTransport({
          command: "/usr/bin/xcrun",
          args: ["mcpbridge"],
          cwd: currentCwd,
          env: {
            ...getDefaultEnvironment(),
            DEVELOPER_DIR,
            ...(process.env.MCP_XCODE_PID ? { MCP_XCODE_PID: process.env.MCP_XCODE_PID } : {}),
          },
          stderr: "pipe",
          maxBufferSize: 50 * 1024 * 1024,
        });
        candidateTransport.stderr?.on("data", (chunk) => {
          stderrTail = capTail(stderrTail, chunk.toString());
        });

        let createdClient!: Client;
        createdClient = new Client(
          { name: "pi-xcode-mcp", version: "0.1.0" },
          {
            capabilities: {},
            listChanged: {
              tools: {
                autoRefresh: true,
                debounceMs: 250,
                onChanged: (error, tools) => {
                  if (client !== createdClient) return;
                  if (error) {
                    lastError = error.message;
                    return;
                  }
                  if (tools) {
                    catalog = tools as McpTool[];
                    updateStatus();
                  }
                },
              },
            },
          },
        );
        candidateClient = createdClient;
        createdClient.onclose = () => markDisconnected(createdClient);
        createdClient.onerror = (error) => {
          if (client === createdClient) lastError = error.message;
        };

        await createdClient.connect(candidateTransport, { timeout: CONNECT_TIMEOUT_MS });
        const listed = await createdClient.listTools(undefined, { timeout: LIST_TIMEOUT_MS });

        client = createdClient;
        transport = candidateTransport;
        catalog = listed.tools as McpTool[];
        state = "connected";
        lastError = undefined;
        updateStatus();
      } catch (error) {
        const base = errorMessage(error);
        const diagnostic = stderrTail.trim() ? `${base}\nBridge diagnostics:\n${stderrTail.trim()}` : base;
        lastError = setupHint(diagnostic);
        state = "error";
        updateStatus();
        if (candidateClient) await candidateClient.close().catch(() => {});
        else if (candidateTransport) await candidateTransport.close().catch(() => {});
        throw new Error(lastError);
      }
    };

    connectPromise = attempt().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  };

  const ensureConnected = async () => {
    if (state === "connected" && client) return client;
    await connect(state === "error");
    if (!client) throw new Error(lastError ?? "Xcode MCP connection failed.");
    return client;
  };

  const refreshCatalog = async () => {
    const activeClient = await ensureConnected();
    const listed = await activeClient.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
    catalog = listed.tools as McpTool[];
    updateStatus();
    return catalog;
  };

  const statusText = () => {
    const lines = [
      `State: ${state}`,
      `Tools: ${catalog.length}`,
      `Xcode project cwd: ${currentCwd}`,
      `Bridge PID: ${transport?.pid ?? "none"}`,
    ];
    if (lastError) lines.push(`Last error: ${lastError}`);
    return lines.join("\n");
  };

  const XcodeAction = StringEnum(["connect", "status", "list", "call", "disconnect"] as const);
  const XcodeParams = Type.Object({
    action: XcodeAction,
    tool: Type.Optional(Type.String({ description: "Exact Xcode MCP tool name for action=call" })),
    arguments: Type.Optional(
      Type.Object({}, {
        additionalProperties: true,
        description: "Arguments matching the selected Xcode MCP tool's inputSchema",
      }),
    ),
  });

  pi.registerTool({
    name: "xcode",
    label: "Xcode MCP",
    description: "Connect to the open Xcode project through Apple's xcrun mcpbridge, list Xcode capabilities, or call an Xcode MCP tool. Use action=list to inspect exact tool schemas before action=call.",
    promptSnippet: "Operate on the open Xcode project through Apple's Xcode MCP bridge",
    promptGuidelines: [
      "Use xcode for Xcode-specific project inspection, builds, tests, diagnostics, previews, and IDE-aware changes when an Xcode project is open.",
      "Before the first unfamiliar Xcode operation, call xcode with action=list, then use action=call with the exact MCP tool name and schema arguments.",
    ],
    parameters: XcodeParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      currentCwd = ctx.cwd;
      statusContext = ctx;

      if (params.action === "status") {
        return { content: [{ type: "text", text: statusText() }], details: { state, toolCount: catalog.length } };
      }
      if (params.action === "disconnect") {
        await disconnect();
        return { content: [{ type: "text", text: "Disconnected from Xcode MCP." }], details: { state } };
      }
      if (params.action === "connect") {
        await connect(true);
        return {
          content: [{ type: "text", text: `Connected to Xcode MCP.\n\n${formatCatalog(catalog, false)}` }],
          details: { state, toolCount: catalog.length },
        };
      }
      if (params.action === "list") {
        await refreshCatalog();
        return {
          content: [{ type: "text", text: truncateText(formatCatalog(catalog, true)) }],
          details: { state, toolCount: catalog.length },
        };
      }

      if (!params.tool) throw new Error("action=call requires the exact Xcode MCP tool name in 'tool'.");
      const activeClient = await ensureConnected();
      const selected = catalog.find((tool) => tool.name === params.tool);
      if (!selected) {
        throw new Error(`Unknown Xcode MCP tool '${params.tool}'. Available tools: ${catalog.map((tool) => tool.name).join(", ") || "none"}. Call xcode with action=list to refresh schemas.`);
      }

      onUpdate?.({ content: [{ type: "text", text: `Xcode is running ${params.tool}...` }] });
      try {
        const result = await activeClient.callTool(
          { name: params.tool, arguments: (params.arguments ?? {}) as Record<string, unknown> },
          undefined,
          {
            signal,
            timeout: CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: CALL_TIMEOUT_MS,
            onprogress: (progress) => {
              const suffix = progress.total ? ` (${progress.progress}/${progress.total})` : "";
              onUpdate?.({ content: [{ type: "text", text: `Xcode is running ${params.tool}${suffix}...` }] });
            },
          },
        );
        const formatted = formatMcpResult(result);
        if ("isError" in result && result.isError) throw new Error(formatted.textForError || `${params.tool} failed.`);
        return {
          content: formatted.content,
          details: { mcpTool: params.tool, structuredContent: formatted.structuredContent },
        };
      } catch (error) {
        lastError = errorMessage(error);
        if (lastError.toLowerCase().includes("connection") || lastError.toLowerCase().includes("closed")) {
          state = "error";
          updateStatus();
        }
        throw new Error(setupHint(lastError));
      }
    },
  });

  pi.registerCommand("xcode-connect", {
    description: "Connect or reconnect Pi to the open Xcode project through MCP",
    handler: async (_args, ctx) => {
      currentCwd = ctx.cwd;
      statusContext = ctx;
      try {
        await connect(true);
        ctx.ui.notify(`Connected to Xcode MCP (${catalog.length} tools).`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("xcode-status", {
    description: "Show Xcode MCP connection status",
    handler: async (_args, ctx) => {
      statusContext = ctx;
      ctx.ui.notify(statusText(), state === "connected" ? "info" : "warning");
    },
  });

  pi.registerCommand("xcode-tools", {
    description: "Refresh and show tools exposed by Xcode MCP",
    handler: async (_args, ctx) => {
      currentCwd = ctx.cwd;
      statusContext = ctx;
      try {
        await refreshCatalog();
        ctx.ui.notify(formatCatalog(catalog, false), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("xcode-disconnect", {
    description: "Disconnect Pi from Xcode MCP",
    handler: async (_args, ctx) => {
      statusContext = ctx;
      await disconnect();
      ctx.ui.notify("Disconnected from Xcode MCP.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    statusContext = ctx;
    if (process.platform !== "darwin") return;

    const running = await pi.exec("pgrep", ["-x", "Xcode"], { timeout: 2_000 }).catch(() => null);
    if (!running || running.code !== 0) {
      state = "disconnected";
      updateStatus();
      return;
    }

    try {
      await connect();
      if (ctx.hasUI) ctx.ui.notify(`Xcode MCP connected (${catalog.length} tools).`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Xcode MCP unavailable: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (state !== "connected" || catalog.length === 0) return;
    const catalogSummary = formatCatalog(catalog, false);
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Open Xcode project\nApple's Xcode MCP bridge is connected. Use the xcode tool for IDE-aware project operations. Available MCP tools:\n${catalogSummary}\nCall xcode with action=list when you need exact input schemas.`,
    };
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (statusContext?.hasUI) statusContext.ui.setStatus("xcode-mcp", undefined);
    await disconnect();
  });
}

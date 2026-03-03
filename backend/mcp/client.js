import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let mcpClient = null;
let mcpTransport = null;
let mcpConnectingPromise = null;

function mcpEnabled() {
  return String(process.env.MCP_ENABLED || "true").toLowerCase() !== "false";
}

function mcpUrl() {
  const host = String(process.env.MCP_HOST || "127.0.0.1");
  const port = Math.max(1, Number(process.env.MCP_PORT) || 4011);
  const path = String(process.env.MCP_PATH || "/mcp");
  return `http://${host}:${port}${path}`;
}

async function ensureConnected() {
  if (!mcpEnabled()) {
    throw new Error("MCP_DISABLED");
  }

  if (mcpClient && mcpTransport) {
    return;
  }

  if (mcpConnectingPromise) {
    await mcpConnectingPromise;
    return;
  }

  mcpConnectingPromise = (async () => {
    const url = new URL(mcpUrl());
    const client = new Client(
      {
        name: "helio-backend-mcp-client",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    mcpClient = client;
    mcpTransport = transport;
  })();

  try {
    await mcpConnectingPromise;
  } finally {
    mcpConnectingPromise = null;
  }
}

function extractTextResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const textChunks = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean);
  return textChunks.join("\n").trim();
}

export async function callMcpTool(name, args = {}) {
  await ensureConnected();
  const response = await mcpClient.callTool({
    name: String(name || "").trim(),
    arguments: args && typeof args === "object" ? args : {}
  });
  const text = extractTextResult(response);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}


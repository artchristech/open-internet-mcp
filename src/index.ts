#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";
import { TOOLS } from "./tools.js";
import { SafeFetchError } from "./safeFetch.js";

const server = new Server(
  { name: "open-internet-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
    };
  }
  const parsed = tool.schema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `invalid arguments: ${parsed.error.errors
            .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
            .join("; ")}`,
        },
      ],
    };
  }
  try {
    const text = await tool.call(parsed.data);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg =
      e instanceof SafeFetchError
        ? `[${e.code}${e.status ? " " + e.status : ""}] ${e.message}`
        : (e as Error).message;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  // Stderr only — stdout is reserved for MCP frame traffic.
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});

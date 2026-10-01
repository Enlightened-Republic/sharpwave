// packages/server/src/http.ts
//
// HTTP surface:
//   GET  /health  — unauthenticated; returns ONLY {status, version, addresses}.
//   POST /mcp     — MCP Streamable HTTP (official SDK transport, stateless,
//                   JSON responses). Bearer token required → 401 otherwise.
//   GET/DELETE /mcp → 405 (stateless server: no standalone SSE stream, no sessions).
//
// Each POST gets a fresh SDK Server + StreamableHTTPServerTransport bound to
// the authenticated principal, so identity can never leak between requests.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { TokenStore, Principal } from "./tokens.js";
import { callTool, toolsFor, type ToolContext } from "./tools.js";
import type { Logger } from "./log.js";
import { VERSION } from "./version.js";

export interface HttpDeps {
  tokens: TokenStore;
  makeContext: (p: Principal) => ToolContext;
  addresses: () => string[];
  maxBodyBytes: number;
  allowedOrigins: string[];
  log: Logger;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(data);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

export function bearerFrom(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        rejectP(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectP);
  });
}

export function createHandler(deps: HttpDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return rpcError(res, 405, -32000, "Method not allowed", { allow: "GET, HEAD" });
        return sendJson(res, 200, { status: "ok", version: VERSION, addresses: deps.addresses() });
      }

      if (path !== "/mcp") return sendJson(res, 404, { error: "not found" });

      // Browsers always send Origin on cross-origin requests; CLI/agent clients don't.
      const origin = req.headers["origin"];
      if (typeof origin === "string" && !deps.allowedOrigins.includes(origin)) {
        return rpcError(res, 403, -32000, "Forbidden origin");
      }

      const principal = deps.tokens.verify(bearerFrom(req));
      if (!principal) {
        return rpcError(res, 401, -32001, "Unauthorized: missing or invalid bearer token", {
          "www-authenticate": 'Bearer realm="sharpwave"',
        });
      }

      if (req.method !== "POST") return rpcError(res, 405, -32000, "Method not allowed (stateless server: POST only)", { allow: "POST" });

      let body: unknown;
      try {
        const raw = await readBody(req, deps.maxBodyBytes);
        body = JSON.parse(raw);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 400;
        return rpcError(res, status, -32700, status === 413 ? "Payload too large" : "Parse error");
      }

      const ctx = deps.makeContext(principal);
      const server = new Server({ name: "sharpwave-server", version: VERSION }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(principal) }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const r = await callTool(ctx, request.params.name, (request.params.arguments as Record<string, unknown>) ?? {});
        return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      deps.log.error(`request failed: ${String(e instanceof Error ? e.stack ?? e.message : e)}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
      else res.end();
    }
  };
}

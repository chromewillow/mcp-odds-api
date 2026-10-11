/**
 * Cloudflare Worker entry point for the odds-api pack.
 *
 * Serves the same tools as src/server.ts (the stdio entry point), but over MCP
 * Streamable HTTP so any remote MCP client can connect to a URL:
 *
 *     POST https://<worker>.workers.dev/mcp
 *
 * Stateless: every POST gets a fresh Server + transport, so the Worker needs no
 * Durable Objects or KV. The pack itself (src/index.ts) is imported unchanged.
 *
 * Secrets (set with `wrangler secret put <NAME>`):
 *   ODDS_API_KEY    — The Odds API key used when a caller does not bring their own.
 *   MCP_AUTH_TOKEN  — When set, /mcp requires `Authorization: Bearer <token>` or
 *                     `?token=<token>`. Strongly recommended whenever ODDS_API_KEY
 *                     is set, or anyone who finds the URL spends your credits.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import pack from '../../src/index.js';
import pkg from '../../package.json';

interface Env {
  ODDS_API_KEY?: string;
  MCP_AUTH_TOKEN?: string;
}

const MCP_PATH = '/mcp';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function buildServer(defaultApiKey: string | undefined): Server {
  const server = new Server(
    { name: 'mcp-odds-api', version: pkg.version },
    { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: pack.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // The pack reads its key from `_apiKey`. A key the caller passed (in the
    // tool arguments or as ?_apiKey= on the URL) wins over the Worker's own.
    const callArgs: Record<string, unknown> = { ...(args ?? {}) };
    if (!callArgs._apiKey && defaultApiKey) callArgs._apiKey = defaultApiKey;
    try {
      const result = await pack.callTool(name, callArgs);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

async function isAuthorized(request: Request, url: URL, expected: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const presented = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? url.searchParams.get('token') ?? '';
  if (!presented) return false;
  // Hash first so both sides are the same length for the constant-time compare.
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', ...extra },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        name: pkg.name,
        version: pkg.version,
        transport: 'streamable-http',
        endpoint: `${url.origin}${MCP_PATH}`,
        auth: env.MCP_AUTH_TOKEN ? 'bearer token required' : 'none',
        odds_api_key: env.ODDS_API_KEY ? 'configured' : 'not configured — callers must pass ?_apiKey=',
        tools: pack.tools.map((t) => t.name),
      });
    }

    if (url.pathname !== MCP_PATH) {
      return json({ error: 'not_found', hint: `The MCP endpoint is ${MCP_PATH}` }, 404);
    }

    if (env.MCP_AUTH_TOKEN && !(await isAuthorized(request, url, env.MCP_AUTH_TOKEN))) {
      return json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
        401,
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    // Stateless server: there is no session to hold a standalone SSE stream or
    // to delete, so GET and DELETE are answered 405 as the spec allows.
    if (request.method !== 'POST') {
      return json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
        405,
        { Allow: 'POST, OPTIONS' },
      );
    }

    const apiKey = url.searchParams.get('_apiKey')?.trim() || env.ODDS_API_KEY;
    const server = buildServer(apiKey);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  },
} satisfies ExportedHandler<Env>;

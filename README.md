# @pipeworx/odds-api

The Odds API MCP — sportsbook odds across 70+ books for 30+ sports leagues (NFL, NBA, MLB, NHL, soccer, MMA, golf, tennis, esports, cricket, ...).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `list_sports(all?)` — list available sports/leagues
- `get_odds(sport_key, regions?, markets?, odds_format?, date_format?, bookmakers?, events?)` — current odds
- `get_event_odds(sport_key, event_id, regions?, markets?)` — odds for a specific event (allows more markets like player props)
- `get_scores(sport_key, days_from?)` — live + recent final scores
- `get_events(sport_key, date_format?, event_ids?)` — list upcoming + live events
- `odds_api_quota()` — credits left and used this month on the key serving the call (free; costs no upstream credit)

## Auth

- **Platform key:** gateway env `PLATFORM_ODDS_API_KEY`
- **BYO:** `?_apiKey=<key>` after registering at https://the-odds-api.com/

Free tier: 500 requests/month. Each odds-payload market counts as 1 request. `list_sports`,
`get_events` and `odds_api_quota` are free — measured 2026-09-01, they do not draw down the
balance.

When the month's credits are spent, the metered tools (`get_odds`, `get_event_odds`, `get_scores`)
return `upstream_throttled` and a hint to bring your own key. Upstream answers an exhausted balance
with **HTTP 401**, the same status as a bad key, so read the message rather than the status:
`odds_api_quota` tells the two apart. Credits reset on the plan anniversary, not on the 1st of the
month, and nothing announces the reset.

`odds_api_quota` also adds `error: "account_limited"` and a plain-English `message` once the
balance hits zero. That is what makes a spent plan visible: the monitor's platform-key board probes
this pack through `odds_api_quota` precisely because it is free to call *and* able to fail. The
board previously probed `get_events`, which keeps answering 200 on a zero balance — so the four
metered tools were dark for eleven days in August 2026 with nothing reporting it. The wording of
that message is a contract with `workers/monitor`; `tests/odds-api-quota-visibility.test.ts`
holds the two together.

## Data source

`https://api.the-odds-api.com/v4/` — `?apiKey=` query.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "odds-api": {
      "url": "https://gateway.pipeworx.io/odds-api/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/odds-api/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

Our odds-api key is reserved for paid accounts, so an anonymous call to `POST https://gateway.pipeworx.io/v1/tools/odds_api_list_sports` needs your own key passed as `_apiKey` alongside the arguments. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/odds_api_list_sports`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "odds-api": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-odds-api"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-odds-api
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Self-host on Cloudflare Workers

`worker/` serves this pack's tools over MCP Streamable HTTP from your own
Cloudflare account, so any remote MCP client can connect to a URL. It is
stateless (no Durable Objects or KV), fits the Workers free plan, and imports
`src/index.ts` unchanged. GitHub Pages cannot host it: Pages serves static
files only, and an MCP server has to run code to call The Odds API.

**Deploy from GitHub Actions.** Add these repository secrets (Settings → Secrets
and variables → Actions), then run the **Deploy to Cloudflare Workers** workflow,
or push to `main`:

| Secret | |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | required — create one from the *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | required — on the Workers & Pages overview page |
| `ODDS_API_KEY` | optional — your key from https://the-odds-api.com |
| `MCP_AUTH_TOKEN` | optional — a long random string clients must send. Set it whenever `ODDS_API_KEY` is set, or anyone with the URL spends your credits |

**Or deploy from your machine:**

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put ODDS_API_KEY
npx wrangler secret put MCP_AUTH_TOKEN
```

The endpoint is `https://mcp-odds-api.<your-subdomain>.workers.dev/mcp`, and
`/health` lists the tools and whether a key and auth are configured. Connect
with a bearer token:

```json
{
  "mcpServers": {
    "odds-api": {
      "url": "https://mcp-odds-api.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

For a client that cannot set headers, put the token in the URL instead:
`.../mcp?token=<MCP_AUTH_TOKEN>`. A caller can also bring their own Odds API key
with `?_apiKey=<key>`, which takes precedence over the Worker's `ODDS_API_KEY`.

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars`
and run `npm run dev` in `worker/`.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Odds Api data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

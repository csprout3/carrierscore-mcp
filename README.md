<img src="https://carrierscore.io/icon-512.png" alt="CarrierScore" width="96" align="right">

# CarrierScore MCP Server

FMCSA motor-carrier risk intelligence for AI agents, over the [Model Context Protocol](https://modelcontextprotocol.io).

CarrierScore answers **"how risky is this carrier, and what was knowable about it on a given date?"** for freight brokers and AI booking/dispatch agents. It builds longitudinal risk scores (0–100, higher = riskier) and timestamped carrier-selection evidence reports ("Montgomery files") from daily archives of public FMCSA / US DOT safety data: census, inspections, crashes, out-of-service orders, operating authority, and insurance filings.

**Website:** [carrierscore.io](https://carrierscore.io) · **Agent docs:** [carrierscore.io/llms.txt](https://carrierscore.io/llms.txt)

## Hosted endpoint (recommended)

No install needed — a hosted Streamable HTTP MCP endpoint is live:

```
https://mcp.carrierscore.io/mcp
```

Keyless requests get a rate-limited **free tier** (lookups, scores, text evidence reports). Paid tiers add carrier-list monitoring, structured JSON evidence reports, and higher volume — see [pricing](https://carrierscore.io/#pricing). Paid tiers authenticate with an `X-API-Key` header (or `CARRIERSCORE_API_KEY` when self-hosting).

## Tools

| Tool | What it does |
| --- | --- |
| `carrier_lookup` | Carrier identity by US DOT number: legal name, DBA, operating status, FMCSA safety rating, fleet size, address, registration dates. Use first to confirm a DOT is real and matches the rate confirmation. |
| `carrier_score` | The CarrierScore risk score (0–100, higher = riskier) with full component breakdown, hard flags (active OOS order, no active insurance, reincarnated-carrier link), and data-sufficiency indicator. |
| `montgomery_file` | Timestamped carrier-selection evidence report — the documented artifact a broker retains at the moment of booking (post *Montgomery v. Caribe Transport II*). Text format on the free tier; JSON on paid tiers. |
| `monitor_carriers` | Batch score summary + flags for up to 100 DOT numbers per call — screen candidates for a load or re-check an active roster. |

## Connect from a client

### Claude Code

```bash
claude mcp add --transport http carrierscore https://mcp.carrierscore.io/mcp
```

### Claude Desktop / claude.ai

Settings → Connectors → Add custom connector → URL `https://mcp.carrierscore.io/mcp`.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "carrierscore": {
      "url": "https://mcp.carrierscore.io/mcp"
    }
  }
}
```

### Generic MCP client (Streamable HTTP)

```json
{
  "mcpServers": {
    "carrierscore": {
      "type": "streamable-http",
      "url": "https://mcp.carrierscore.io/mcp"
    }
  }
}
```

## Self-hosting

The server in this repo is a thin Streamable HTTP client over the CarrierScore REST API (`https://api.carrierscore.io`).

```bash
npm install
npm run build
CARRIERSCORE_API_URL=https://api.carrierscore.io npm start
# MCP endpoint: POST http://127.0.0.1:8322/mcp
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CARRIERSCORE_API_URL` | `http://127.0.0.1:8321` | Base URL of the CarrierScore REST API |
| `CARRIERSCORE_API_KEY` | *(unset)* | Optional API key for paid tiers; unset = rate-limited free tier |
| `PORT` | `8322` | Port for the MCP HTTP endpoint (`POST /mcp`) |

## Disclaimer

CarrierScore scores are computed statistical indicators built from public FMCSA data under a documented, transparent methodology (population percentiles plus hard flags). They are **not** safety fitness determinations, are **not** endorsed by FMCSA, and do not substitute for a carrier's official safety rating or your own judgment. Every score and evidence report embeds this disclaimer — retain it when storing or quoting results.

## License

MIT © SYMBOLIQ LLC. Contact: business@colesprout.com

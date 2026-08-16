#!/usr/bin/env node
/**
 * CarrierScore MCP server (Streamable HTTP).
 *
 * Thin client over the CarrierScore REST API (FastAPI, one shared Python
 * service core). Gives AI booking/dispatch agents the "is this carrier safe
 * to book?" toolset: identity lookup, risk score with component breakdown,
 * the Montgomery carrier-selection evidence file, and batch monitoring.
 *
 * Env:
 *   CARRIERSCORE_API_URL   base URL of the REST API (default http://127.0.0.1:8321)
 *   CARRIERSCORE_API_KEY   optional API key; without it the free tier applies
 *                          (rate-limited, Montgomery file text-only)
 *   PORT                   MCP HTTP port (default 8322), endpoint POST /mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const API_URL = (process.env.CARRIERSCORE_API_URL ?? "http://127.0.0.1:8321").replace(/\/+$/, "");
const API_KEY = process.env.CARRIERSCORE_API_KEY;

const DISCLAIMER =
  "CarrierScore is a summary of public FMCSA data and computed statistical " +
  "indicators. It is not a safety fitness determination, is not endorsed by " +
  "FMCSA, and does not substitute for the carrier's official safety rating " +
  "or a user's own judgment.";

// --- shared API client -------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function apiRequest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ json?: unknown; text: string }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ApiError(
      0,
      `Could not reach the CarrierScore API at ${API_URL} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Is the API running? Start it with: python -m carrierscore serve",
    );
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const detail =
      json && typeof json === "object" && "detail" in json
        ? String((json as { detail: unknown }).detail)
        : text.slice(0, 300);
    throw new ApiError(response.status, apiErrorMessage(response.status, detail));
  }
  return { json, text };
}

function apiErrorMessage(status: number, detail: string): string {
  switch (status) {
    case 401:
      return `Invalid API key: ${detail} Check CARRIERSCORE_API_KEY, or unset it to use the free tier.`;
    case 403:
      return `Not available on the current tier: ${detail}`;
    case 404:
      return `${detail} Verify the DOT number — it must match an FMCSA-registered carrier.`;
    case 429:
      return `Rate limit exceeded: ${detail} Wait before retrying, or set CARRIERSCORE_API_KEY for higher limits.`;
    case 503:
      return `CarrierScore data not ready: ${detail}`;
    default:
      return `CarrierScore API error (HTTP ${status}): ${detail}`;
  }
}

function toolError(error: unknown) {
  const message =
    error instanceof ApiError
      ? error.message
      : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

const dotNumberField = z
  .string()
  .regex(/^\d{1,8}$/, "DOT number must be 1-8 digits")
  .describe("US DOT number of the carrier, digits only (e.g. \"1234567\")");

// --- server ------------------------------------------------------------------

const server = new McpServer({
  name: "carrierscore-mcp-server",
  version: "0.1.0",
});

server.registerTool(
  "carrier_lookup",
  {
    title: "Look Up Carrier Identity",
    description: `Look up an FMCSA-registered motor carrier's identity by US DOT number: legal name, DBA, operating status, FMCSA safety rating, fleet size (power units, drivers), physical address, and registration dates.

Use this first when a booking/dispatch agent needs to confirm WHO a carrier is — that a DOT number is real, active, and matches the company name on a rate confirmation. It does not return a risk score (use carrier_score for that).

Returns JSON: { dot_number, legal_name, dba_name, status_code, safety_rating, power_units, total_drivers, phy_street, phy_city, phy_state, phy_zip, add_date, mcs150_date }.

Errors: 404 if the DOT is not in the FMCSA census (likely a typo or a fraudulent/never-registered carrier — treat as a red flag for booking).`,
    inputSchema: { dot_number: dotNumberField },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dot_number }) => {
    try {
      const { json } = await apiRequest(`/v1/carrier/${dot_number}`);
      return jsonResult(json);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "carrier_score",
  {
    title: "Get Carrier Risk Score",
    description: `Get the CarrierScore risk score (0-100, HIGHER = RISKIER) for a carrier by US DOT number, with a full component breakdown.

This is the core "is this carrier safe to book?" signal for AI booking agents. The score is population-relative and built from public FMCSA data: out-of-service rates, violation trends (acute vs chronic), exposure-normalized crash rates, insurance churn, and operation age. Hard flags (active out-of-service order, no active insurance, high-confidence reincarnated-carrier link) add explicit surcharges — a carrier with any flag deserves extra scrutiny regardless of score.

Returns JSON: { dot_number, legal_name, carrier_score, base_score, surcharge, components: { <name>: { label, value, percentile, weight } }, flags: string[], data_sufficiency (0-1, how much of the score rests on observed vs neutral-imputed data), scored_as_of, disclaimer }.

Interpreting for booking decisions: treat the score as documented decision-support evidence, not an approve/deny verdict. Low data_sufficiency means limited inspection history — common for new carriers, itself a risk signal. Always relay the disclaimer when presenting the score.

Errors: 404 if the DOT is not in the scored population; 503 if scores have not been computed yet.`,
    inputSchema: { dot_number: dotNumberField },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dot_number }) => {
    try {
      const { json } = await apiRequest(`/v1/carrier/${dot_number}/score`);
      return jsonResult(json);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "montgomery_file",
  {
    title: "Generate Montgomery Evidence File",
    description: `Generate a timestamped Montgomery file — a carrier-selection evidence report — for a carrier by US DOT number.

Since Montgomery v. Caribe Transport II (SCOTUS, May 2026), freight brokers are exposed to state-law negligent-selection claims and need documented, timestamped, safety-data-based carrier selection. This report is that artifact: score, component percentiles, hard flags, FMCSA safety rating, and the methodology disclaimer, dated as of the scoring run. A booking agent should generate and retain this file at the moment a carrier is selected for a load.

Args:
  - dot_number: US DOT number, digits only
  - format: "text" (default; the filing-ready plain-text report, available on the free tier) or "json" (structured fields; requires an API key on the monitor or compliance tier)

Returns: the plain-text report, or JSON { report, generated, dot_number, legal_name, dba_name, safety_rating, status_code, power_units, carrier_score, components, flags, data_sufficiency, scored_as_of, disclaimer }. Every report embeds the disclaimer verbatim — keep it when storing or quoting the report.

Errors: 403 if format=json without an API key; 404 unknown DOT; 503 if scores are not computed yet.`,
    inputSchema: {
      dot_number: dotNumberField,
      format: z
        .enum(["text", "json"])
        .default("text")
        .describe("\"text\" = filing-ready report (free tier); \"json\" = structured fields (requires API key)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dot_number, format }) => {
    try {
      const { json, text } = await apiRequest(
        `/v1/carrier/${dot_number}/montgomery?format=${format}`,
      );
      if (format === "json") return jsonResult(json);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "monitor_carriers",
  {
    title: "Monitor Carrier List",
    description: `Batch risk check for a list of carriers by US DOT number (max 100 per call): score summary and hard flags for each.

Use when an agent is screening multiple candidate carriers for a load, or re-checking a broker's active carrier roster ("did any of my carriers pick up an out-of-service order or drop insurance?"). For a full breakdown of any single carrier that looks risky here, follow up with carrier_score or montgomery_file.

Args:
  - dot_numbers: array of DOT number strings, 1-100 entries

Returns JSON: { scored_as_of, requested, found, carriers: [{ dot_number, legal_name, carrier_score (0-100, higher = riskier), data_sufficiency, flags: string[] }], not_found: string[], disclaimer }. DOTs in not_found are absent from the scored population — verify them with carrier_lookup; an unknown DOT on your roster is itself a red flag.

Errors: 400 if the list is empty or exceeds 100 (split into batches); 503 if scores are not computed yet.`,
    inputSchema: {
      dot_numbers: z
        .array(dotNumberField)
        .min(1)
        .max(100)
        .describe("US DOT numbers to check, 1-100 per call"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dot_numbers }) => {
    try {
      const { json } = await apiRequest("/v1/monitor", {
        method: "POST",
        body: dot_numbers,
      });
      return jsonResult(json);
    } catch (error) {
      return toolError(error);
    }
  },
);

// --- transport: stateless Streamable HTTP ------------------------------------

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", api_url: API_URL, disclaimer: DISCLAIMER });
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT ?? "8322", 10);
app.listen(port, "127.0.0.1", () => {
  console.error(
    `carrierscore-mcp-server listening on http://127.0.0.1:${port}/mcp ` +
      `(backend API: ${API_URL}${API_KEY ? ", API key set" : ", free tier"})`,
  );
});

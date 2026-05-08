#!/usr/bin/env node
"use strict";

/**
 * index.js — BaseGuard + WalletGuard MCP server.
 *
 * Exposes four tools via the Model Context Protocol (stdio transport):
 *
 *   check_token_safety       Full token safety analysis (deployer + LP + holders)
 *   check_token_safety_lite  Fast pre-trade check (deployer + LP only, sub-3s)
 *   check_wallet             Full wallet intelligence profile
 *   check_wallet_quick       Fast wallet age + tx count check (sub-2s)
 *
 * Two operating modes, selected via MCP_MODE env var:
 *
 *   MCP_MODE=local  (default on VPS)
 *     Calls BaseGuard and WalletGuard engines directly — no HTTP round-trips.
 *     API keys loaded from /root/baseguard/.env (shared by both services).
 *
 *   HTTP mode  (default when installed via npx)
 *     Calls the free demo oracle at oracle.scoopflashman.tech.
 *     Rate limit: 10 requests per IP per hour.
 *     No API keys required.
 *
 * MCP communicates over stdin/stdout. Never write to stdout except via the SDK.
 * Use stderr for diagnostics.
 */

const LOCAL_MODE  = process.env.MCP_MODE === "local";
const ORACLE_BASE = "https://oracle.scoopflashman.tech";

const { McpServer }            = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z }                    = require("zod");

// ── Local mode: load engines directly ─────────────────────────────────────────

let runLocal, runPumpLocal, analyseLocal, quickLocal, farcasterLocal, holderGrowthLocal, proVerdictLocal;

if (LOCAL_MODE) {
  // Load shared API keys before importing engines so their dotenv calls are no-ops
  require("dotenv").config({ path: "/root/baseguard/.env" });
  runLocal          = require("/root/baseguard/src/verdict.js").run;
  runPumpLocal      = require("/root/baseguard/src/pump-verdict.js").runPumpVerdict;
  analyseLocal      = require("/root/walletguard/src/wallet.js").analyse;
  quickLocal        = require("/root/walletguard/src/wallet.js").quick;
  const proMod      = require("/root/baseguard/src/pro-signals.js");
  farcasterLocal    = proMod.getFarcasterActivity;
  holderGrowthLocal = proMod.getHolderGrowthVelocity;
  proVerdictLocal   = proMod.deriveProVerdict;
  process.stderr.write("[baseguard-walletguard-mcp] Mode: local (direct engine calls)\n");
} else {
  process.stderr.write(`[baseguard-walletguard-mcp] Mode: HTTP (oracle: ${ORACLE_BASE})\n`);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function oraclePost(path, body) {
  const res = await fetch(`${ORACLE_BASE}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.error || `Oracle HTTP ${res.status}`);
  }
  return json;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── Server factory (one instance per session in HTTP mode, one for stdio) ─────

function createMcpServer() {
  const srv = new McpServer({
    name:    "baseguard-walletguard",
    version: "1.0.0",
  });

// ── Tool 1: check_token_safety ────────────────────────────────────────────────

srv.tool(
  "check_token_safety",
  "Full token safety analysis. Returns a risk score (0-100, lower is safer), " +
  "a SAFE / CAUTION / AVOID recommendation, a confidence level, and three sub-checks: " +
  "deployer wallet age in days, whether the liquidity pool is locked, and top-10 holder concentration percentage. " +
  "Solana support includes Pump.fun bonding curve detection with live SOL reserve and bonding curve PDA, " +
  "graduation status, and Raydium LP lock checks. Bonding curve program addresses are excluded from holder concentration. " +
  "Use this before trading or listing any token. " +
  "Supports Base, Ethereum, Arbitrum, and Solana. Results are cached for 4 hours.",
  {
    contractAddress: z.string().describe(
      "Token contract address to analyse. Use 0x-prefixed hex for EVM chains (Base, Ethereum, Arbitrum) or base58 for Solana."
    ),
    chainId: z.enum(["base", "ethereum", "arbitrum", "solana"]).default("base").describe(
      "Blockchain network the token is deployed on. Defaults to Base if omitted."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ contractAddress, chainId }) => {
    try {
      let r;
      if (LOCAL_MODE) {
        r = await runLocal(chainId, contractAddress, { lite: false });
      } else {
        r = await oraclePost("/check-token", { contractAddress, chainId });
      }
      return ok({
        contractAddress:  r.contractAddress,
        chainId:          r.chainId,
        token:            r.token,
        riskScore:        r.riskScore,
        recommendation:   r.recommendation,
        confidence:       r.confidence,
        checks: {
          deployer: {
            walletAgeDays: r.checks.deployer.walletAgeDays,
            priorLaunches: r.checks.deployer.priorLaunches,
            flag:          r.checks.deployer.flag,
          },
          liquidity: {
            lpLocked:         r.checks.liquidity.lpLocked,
            lockDurationDays: r.checks.liquidity.lockDurationDays,
            liquidityUsd:     r.checks.liquidity.liquidityUsd,
            flag:             r.checks.liquidity.flag,
          },
          holders: {
            top10Concentration: r.checks.holders.top10Concentration,
            top5Concentration:  r.checks.holders.top5Concentration,
            flag:               r.checks.holders.flag,
          },
        },
        processingMs: r.processingMs,
        _cached:      r._cached ?? false,
      });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Tool 2: check_token_safety_lite ──────────────────────────────────────────

srv.tool(
  "check_token_safety_lite",
  "Fast token pre-trade check — deployer wallet age and LP lock status only, no holder concentration analysis. " +
  "Typically completes in under 3 seconds. " +
  "Returns risk score, SAFE / CAUTION / AVOID recommendation, deployer age in days, and LP lock flag. " +
  "Solana supported including Pump.fun bonding curve detection and Raydium graduation check. " +
  "Use this when screening many tokens quickly. " +
  "For full holder analysis use check_token_safety instead.",
  {
    contractAddress: z.string().describe(
      "Token contract address to check. Use 0x-prefixed hex for EVM chains or base58 for Solana."
    ),
    chainId: z.enum(["base", "ethereum", "arbitrum", "solana"]).default("base").describe(
      "Blockchain network the token is deployed on. Defaults to Base if omitted."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ contractAddress, chainId }) => {
    try {
      let r;
      if (LOCAL_MODE) {
        r = await runLocal(chainId, contractAddress, { lite: true });
      } else {
        // HTTP mode: call full check, return lite-shaped response
        r = await oraclePost("/check-token", { contractAddress, chainId });
      }
      return ok({
        contractAddress:  r.contractAddress,
        chainId:          r.chainId,
        token:            r.token,
        riskScore:        r.riskScore,
        recommendation:   r.recommendation,
        deployerAgeDays:  r.checks.deployer.walletAgeDays,
        deployerFlag:     r.checks.deployer.flag,
        lpLocked:         r.checks.liquidity.lpLocked,
        lpFlag:           r.checks.liquidity.flag,
        processingMs:     r.processingMs,
        _cached:          r._cached ?? false,
      });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Tool 2b: check_token_safety_pro ──────────────────────────────────────────

srv.tool(
  "check_token_safety_pro",
  "Pro token safety analysis. Runs the full standard verdict (deployer age, LP lock, holder concentration) " +
  "and adds two additional signals: " +
  "(1) Farcaster social activity — casts mentioning the token address in the last 24h, including mention count, " +
  "unique caster count, and keyword-based sentiment (positive/neutral/negative); " +
  "(2) Holder growth velocity — estimated holder count now vs ~24h ago, growth rate percentage, and trend " +
  "(accelerating/stable/declining). Holder growth velocity is Base chain only — returns trend: unknown for " +
  "Solana, Ethereum, and Arbitrum. Farcaster signals work for all chains. " +
  "Solana tokens receive full Pump.fun bonding curve and Raydium LP analysis in the base verdict block. " +
  "Returns a proVerdict that may upgrade SAFE to CAUTION when holder growth is anomalous (>50% or <-30%) " +
  "or Farcaster sentiment is negative. CAUTION and AVOID are never downgraded. " +
  "Priced at $0.50 USDC via x402.",
  {
    contractAddress: z.string().describe(
      "Token contract address to analyse. Use 0x-prefixed hex for EVM chains (Base, Ethereum, Arbitrum) or base58 for Solana."
    ),
    chainId: z.enum(["base", "ethereum", "arbitrum", "solana"]).default("base").describe(
      "Blockchain network the token is deployed on. Defaults to Base if omitted."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ contractAddress, chainId }) => {
    try {
      let base, farcaster, holderGrowth;
      if (LOCAL_MODE) {
        [base, farcaster, holderGrowth] = await Promise.all([
          runLocal(chainId, contractAddress, { lite: false }),
          farcasterLocal(contractAddress),
          holderGrowthLocal(contractAddress, chainId),
        ]);
      } else {
        // HTTP mode: call the combined /check-token-pro oracle endpoint
        const combined = await oraclePost("/check-token-pro", { contractAddress, chainId });
        if (combined.pro) {
          return ok({
            contractAddress:  combined.contractAddress,
            chainId:          combined.chainId,
            token:            combined.token,
            riskScore:        combined.riskScore,
            recommendation:   combined.recommendation,
            confidence:       combined.confidence,
            checks:           combined.checks,
            pro:              combined.pro,
            processingMs:     combined.processingMs,
            _cached:          combined._cached ?? false,
          });
        }
        // Fallback: use standard response with empty pro block
        base        = combined;
        farcaster   = { mentionCount: 0, uniqueCasters: 0, sentiment: "neutral", note: "oracle_unavailable" };
        holderGrowth = { holdersNow: null, holders24hAgo: null, growthRate: null, trend: "unknown", note: "oracle_unavailable" };
      }
      const { proVerdict, upgraded, reasons } = LOCAL_MODE
        ? proVerdictLocal(base.recommendation, holderGrowth, farcaster)
        : { proVerdict: base.recommendation, upgraded: false, reasons: [] };

      return ok({
        contractAddress:  base.contractAddress,
        chainId:          base.chainId,
        token:            base.token,
        riskScore:        base.riskScore,
        recommendation:   base.recommendation,
        confidence:       base.confidence,
        checks:           base.checks,
        pro: {
          proVerdict,
          proVerdictUpgraded: upgraded,
          proUpgradeReasons:  reasons,
          farcaster,
          holderGrowth,
        },
        processingMs: base.processingMs,
        _cached:      base._cached ?? false,
      });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Tool 2c: check_pump_token ─────────────────────────────────────────────────

srv.tool(
  "check_pump_token",
  "Fast Pump.fun token safety check optimised for low latency. Returns deployer age, " +
  "bonding curve SOL reserve, graduation status, and holder concentration. Solana only. " +
  "Use this for time-sensitive trading decisions on Pump.fun tokens. " +
  "Skips the LP lock check on ungraduated tokens (the dominant latency bottleneck in /verdict/lite), " +
  "achieving sub-1,000ms cold responses. " +
  "AVOID if deployer is <1 day old or bonding curve reserve <1 SOL. " +
  "CAUTION if deployer is <7 days old, reserve <5 SOL, graduated (LP unknown), or top-10 holders >50%. " +
  "Returns 400 if the token is not a Pump.fun token — use check_token_safety instead. " +
  "Priced at $0.02 USDC.",
  {
    contractAddress: z.string().describe(
      "Pump.fun token mint address (base58 encoded Solana public key)."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ contractAddress }) => {
    try {
      let r;
      if (LOCAL_MODE) {
        r = await runPumpLocal(contractAddress);
        if (!r.isPumpfun) {
          return err("not a pump.fun token — use check_token_safety instead");
        }
      } else {
        r = await oraclePost("/check-token-pump", { contractAddress, chainId: "solana" });
      }
      return ok({
        contractAddress:            r.contractAddress,
        chainId:                    r.chainId,
        isPumpfun:                  r.isPumpfun,
        graduated:                  r.graduated,
        bondingCurveReserveSol:     r.bondingCurveReserveSol,
        bondingCurvePda:            r.bondingCurvePda,
        deployer:                   r.deployer,
        holderConcentration:        r.holderConcentration,
        holderConcentrationSkipped: r.holderConcentrationSkipped,
        riskScore:                  r.riskScore,
        recommendation:             r.recommendation,
        confidence:                 r.confidence,
        processingMs:               r.processingMs,
        dataSources:                r.dataSources,
      });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Tool 3: check_wallet ──────────────────────────────────────────────────────

srv.tool(
  "check_wallet",
  "Full wallet intelligence profile for any EVM address. " +
  "Returns a CLEAN / SUSPICIOUS / FLAGGED verdict, composite risk score (0-100, lower is safer), " +
  "whale/mid/retail classification by holdings, bot likelihood score (0-100), " +
  "contract deploy count as a rug-pull proxy, active chains, wallet age in days, transaction count, " +
  "and risk flags such as NEW_WALLET, HIGH_BOT_SCORE, MIXER_INTERACTIONS, and SERIAL_DEPLOYER. " +
  "Use this to evaluate token deployers, counterparties, or airdrop claimants. Cached 1 hour.",
  {
    address: z.string().describe(
      "EVM wallet address to profile. Must be a 0x-prefixed 42-character hex address."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ address }) => {
    try {
      let r;
      if (LOCAL_MODE) {
        r = await analyseLocal(address);
      } else {
        r = await oraclePost("/check-wallet", { address });
      }
      return ok({
        address:        r.address,
        verdict:        r.verdict,
        riskScore:      r.riskScore,
        riskFlags:      r.riskFlags,
        ageDays:        r.age.days,
        firstSeen:      r.age.firstSeen,
        txCount:        r.txCount,
        chains:         r.chains,
        botScore:       r.botScore,
        classification: r.classification,
        rugHistory:     r.rugHistory,
        processingMs:   r.processingMs,
        _cached:        r._cached ?? false,
      });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Tool 4: check_wallet_quick ────────────────────────────────────────────────

srv.tool(
  "check_wallet_quick",
  "Fast wallet check — wallet age in days and outgoing transaction count only. " +
  "Typically completes in under 2 seconds. " +
  "Returns a simple CLEAN / SUSPICIOUS verdict alongside age and tx count. " +
  "Use this when confirming a wallet is not brand-new before a quick trust decision, " +
  "such as filtering obvious sybils in an airdrop. " +
  "For full risk profiling including bot score, classification, and rug history use check_wallet.",
  {
    address: z.string().describe(
      "EVM wallet address to check. Must be a 0x-prefixed 42-character hex address."
    ),
  },
  { readOnlyHint: true, openWorldHint: true },
  async ({ address }) => {
    try {
      let r;
      if (LOCAL_MODE) {
        r = await quickLocal(address);
      } else {
        // HTTP mode: call full check, return quick-shaped response
        const full = await oraclePost("/check-wallet", { address });
        r = {
          address:      full.address,
          ageDays:      full.age?.days ?? full.ageDays,
          txCount:      full.txCount,
          verdict:      full.verdict === "FLAGGED" ? "SUSPICIOUS" : full.verdict,
          processingMs: full.processingMs,
        };
      }
      return ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Prompt: token-safety-check ────────────────────────────────────────────────

srv.prompt(
  "token-safety-check",
  "Check if a token is safe before trading",
  {
    contractAddress: z.string().describe("The token contract address to check"),
    chainId: z.string().optional().describe("The blockchain network (base, ethereum, arbitrum, solana). Defaults to base."),
  },
  ({ contractAddress, chainId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Check if this token is safe to trade: ${contractAddress} on ${chainId || "base"}`,
      },
    }],
  })
);

  return srv;
}

// ── Start ─────────────────────────────────────────────────────────────────────

const HTTP_MODE = process.argv.includes("--http");

// Parse --port <n> or --port=<n>
function parsePort() {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) return parseInt(args[i + 1], 10);
    const m = args[i].match(/^--port=(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return 3006;
}

async function startHttp() {
  const express = require("express");
  const { randomUUID } = require("crypto");
  const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

  const port = parsePort();
  const app  = express();

  // Per-session transports keyed by sessionId
  const transports = {};

  // CORS — allow all origins (remote agents connect from anywhere)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ mode: "http", port, tools: 4, sessions: Object.keys(transports).length });
  });

  // POST /mcp — new session (initialize) or existing session messages
  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const mcpServer = createMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // DELETE /mcp — session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.listen(port, () => {
    process.stderr.write(`[baseguard-walletguard-mcp] HTTP/Streamable server ready on port ${port}\n`);
    process.stderr.write(`[baseguard-walletguard-mcp]   POST   http://localhost:${port}/mcp\n`);
    process.stderr.write(`[baseguard-walletguard-mcp]   GET    http://localhost:${port}/mcp\n`);
    process.stderr.write(`[baseguard-walletguard-mcp]   DELETE http://localhost:${port}/mcp\n`);
    process.stderr.write(`[baseguard-walletguard-mcp]   GET    http://localhost:${port}/health\n`);
  });

  process.on("SIGINT", async () => {
    for (const sid of Object.keys(transports)) {
      try { await transports[sid].close(); } catch (_) {}
      delete transports[sid];
    }
    process.exit(0);
  });
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  process.stderr.write("[baseguard-walletguard-mcp] Server ready (stdio)\n");
}

if (HTTP_MODE) {
  startHttp().catch(e => {
    process.stderr.write(`[baseguard-walletguard-mcp] Fatal: ${e.message}\n`);
    process.exit(1);
  });
} else {
  startStdio().catch(e => {
    process.stderr.write(`[baseguard-walletguard-mcp] Fatal: ${e.message}\n`);
    process.exit(1);
  });
}

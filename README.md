# BaseGuard + WalletGuard MCP Server

Exposes BaseGuard and WalletGuard as Model Context Protocol tools so AI
assistants (Claude, Cursor, Windsurf, etc.) can run on-chain token and wallet
safety checks in-context — no API keys required on the client side.

## Tools

| Tool | What it does | Typical latency |
|---|---|---|
| `check_token_safety` | Full token analysis: deployer age, LP lock, holder concentration | 3–8s |
| `check_token_safety_lite` | Fast pre-trade check: deployer + LP only | <3s |
| `check_token_safety_pro` | Full verdict + Farcaster social signals + holder growth velocity; `proVerdict` may upgrade SAFE→CAUTION | 8–15s |
| `check_pump_token` | Fast Pump.fun token safety check optimised for low latency (p50 474ms). Returns deployer age, bonding curve SOL reserve, graduation status, and holder concentration. Solana only. Use for time-sensitive trading decisions on Pump.fun tokens. $0.02 USDC. | ~474ms |
| `check_wallet` | Full wallet profile: verdict, bot score, classification, rug history | 3–6s |
| `check_wallet_quick` | Fast wallet age + tx count | <2s |

Supported chains: **Base**, **Ethereum**, **Arbitrum**, **Solana**.
Holder growth velocity in `check_token_safety_pro` is **Base only** (requires Blockscout V2 + EVM RPC); other chains return `trend: "unknown"` gracefully.

---

## Quick Start (npx — no install required)

```bash
npx -y baseguard-walletguard-mcp
```

The server starts in **HTTP mode**, proxying requests through the free demo
oracle at `oracle.scoopflashman.tech` (rate limit: 10 req/IP/hour, no API key needed).

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "baseguard": {
      "command": "npx",
      "args": ["-y", "baseguard-walletguard-mcp"]
    }
  }
}
```

Restart Claude Desktop. The six tools appear automatically.

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "baseguard": {
      "command": "npx",
      "args": ["-y", "baseguard-walletguard-mcp"]
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "baseguard": {
      "command": "npx",
      "args": ["-y", "baseguard-walletguard-mcp"]
    }
  }
}
```

---

## VPS / Self-hosted Installation

On a server that has the BaseGuard and WalletGuard engines installed locally,
you can run in **local mode** for unlimited, direct engine calls:

```json
{
  "mcpServers": {
    "baseguard-walletguard": {
      "command": "node",
      "args": ["/root/mcp-server/index.js"],
      "env": {
        "MCP_MODE": "local"
      }
    }
  }
}
```

Local mode loads the engines directly and uses `/root/baseguard/.env` for API keys.

### Remote (Streamable HTTP — no SSH required)

Connect directly to the hosted Streamable HTTP server:

```json
{
  "mcpServers": {
    "baseguard-walletguard": {
      "url": "https://mcp.scoopflashman.tech/mcp"
    }
  }
}
```

### Remote VPS (SSH tunnel)

```json
{
  "mcpServers": {
    "baseguard-walletguard": {
      "command": "ssh",
      "args": [
        "-T",
        "root@YOUR_VPS_IP",
        "MCP_MODE=local node /root/mcp-server/index.js"
      ]
    }
  }
}
```

---

## Operating Modes

| Mode | Set via | Engine calls | Rate limit |
|---|---|---|---|
| **HTTP** (default) | _(no env var)_ | `oracle.scoopflashman.tech` free demo | 10 req/IP/hour |
| **Local** | `MCP_MODE=local` | Direct engine requires | Unlimited |

---

## Transport

The VPS instance runs as a **persistent HTTP server** on port 3006 using the **MCP Streamable HTTP transport** (migrated from SSE, 2026-04-17). Clients connect to:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | New session (initialize) or existing session messages |
| `GET` | `/mcp` | SSE stream for server-initiated messages |
| `DELETE` | `/mcp` | Session termination |

Session IDs are assigned server-side and exchanged via the `mcp-session-id` header. Each session gets its own `McpServer` instance.

The `npx` / stdio distribution still uses stdio transport (per the MCP specification for local spawned processes).

A `smithery.yaml` is included for Smithery/Glama registry submission.

## How it works

**HTTP mode** (npx): calls the free oracle demo endpoints:
- `POST /check-token` → BaseGuard full analysis
- `POST /check-token-pro` → BaseGuard pro verdict (Farcaster + holder growth)
- `POST /check-wallet` → WalletGuard full profile

**Local mode** (VPS): calls engines in-process:
- `run()` from `/root/baseguard/src/verdict.js`
- `runPumpVerdict()` from `/root/baseguard/src/pump-verdict.js` — powers `check_pump_token` (`POST /verdict/pump`)
- `getFarcasterActivity()` / `getHolderGrowthVelocity()` from `/root/baseguard/src/pro-signals.js`
- `analyse()` / `quick()` from `/root/walletguard/src/wallet.js`

---

## Testing

Syntax check:
```bash
node --check /root/mcp-server/index.js
```

Streamable HTTP smoke test (initialize handshake):
```bash
curl -s -X POST http://localhost:3006/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'
# Expect: HTTP 200, mcp-session-id header, SSE event with initialize result
```

Stdio protocol test (MCP initialize + tools/list handshake):
```bash
printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' \
  | node /root/mcp-server/index.js
```

---

## Links

- Oracle: [oracle.scoopflashman.tech](https://oracle.scoopflashman.tech)
- BaseGuard API: [baseguard.scoopflashman.tech](https://baseguard.scoopflashman.tech)
- WalletGuard API: [walletguard.scoopflashman.tech](https://walletguard.scoopflashman.tech)

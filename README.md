# TokenGuard MCP Server

> On-chain token safety oracles for AI agents — via Model Context Protocol

[![npm](https://img.shields.io/npm/v/@scoopflashman/baseguard-mcp)](https://www.npmjs.com/package/@scoopflashman/baseguard-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-blue)](https://smithery.ai)
[![Glama](https://img.shields.io/badge/Glama-listed-purple)](https://glama.ai)

Use TokenGuard directly from Claude, AgentKit, or any MCP-compatible client.
No API key. No account. Verdicts in under 500ms.

## Install

```bash
npx @smithery/cli install tokenguard
```

## MCP Server URL
https://mcp.tokenguard.net/mcp

## Available Tools

| Tool | Description | Price |
|------|-------------|-------|
| `check_pump_token` | PumpGuard — Pump.fun safety verdict | $0.02 |
| `check_evm_token` | BaseGuard — EVM token safety verdict | $0.02–$0.20 |
| `check_wallet` | WalletGuard — EVM wallet intelligence | $0.10 |

## Usage in Claude

Once installed via Smithery, ask Claude:
Check this Pump.fun token for rug signals: [mint address]

Is this wallet safe to trade with: [0x address]

## Usage via API

```javascript
import { wrapFetchWithPayment } from '@coinbase/x402-fetch';

const fetch = wrapFetchWithPayment(globalThis.fetch, wallet);

// PumpGuard
const res = await fetch('https://tokenguard.net/verdict/pump', {
  method: 'POST',
  body: JSON.stringify({ 
    contractAddress: mintAddress,
    chainId: 'solana'
  })
});
const { recommendation } = await res.json();
// "SAFE" | "CAUTION" | "AVOID" — $0.02 deducted automatically

// BaseGuard
const res = await fetch('https://tokenguard.net/verdict', {
  method: 'POST',
  body: JSON.stringify({ 
    contractAddress: tokenAddress,
    chainId: 'base' // "base" | "ethereum" | "arbitrum"
  })
});

// WalletGuard
const res = await fetch('https://tokenguard.net/wallet', {
  method: 'POST',
  body: JSON.stringify({ address: walletAddress })
});
```

## The Proof

- **0%** of DANGER tokens survive 24 hours — verified across 50,000+ scans
- **10×** better survival rate on SAFE vs DANGER tokens
- All verdicts verifiable on Solscan / Etherscan

## Links

- 🌐 [tokenguard.net](https://tokenguard.net)
- 📖 [Documentation](https://tokenguard.net/docs)
- 🔴 [PumpGuard](https://tokenguard.net/pump)
- 🟢 [BaseGuard](https://tokenguard.net/base)
- 🟡 [WalletGuard](https://tokenguard.net/wallet)
- 📦 [npm package](https://www.npmjs.com/package/@scoopflashman/baseguard-mcp)

## License

MIT

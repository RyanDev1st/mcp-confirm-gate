# mcp-confirm-gate

Cryptographic human-in-the-loop confirmation gate for state-mutating Model Context Protocol (MCP) tools.

## The Problem

Large language model agents equipped with MCP tool access can invoke destructive or state-mutating operations directly (e.g., dropping database tables, deleting records, releasing financial settlements, or dispatching emails).

Common prompts like `"Are you sure?"` fail because:
1. The LLM agent can hallucinate or fabricate `confirm: true` in the next turn without actual human involvement.
2. Tool calls are stateless; a rogue agent can guess boolean flags or bypass conversational guards.
3. Arguments can be surreptitiously swapped between the prompt and execution phases.

`mcp-confirm-gate` solves this by enforcing a cryptographic two-step handshake. When a mutating tool is invoked without a valid token, execution halts immediately and the server issues a single-use, HMAC-SHA256 signed, time-limited token tied to the canonical hash of the exact arguments. The tool will only execute if presented with the unexpired, unused token matching the exact argument payload.

---

## Quick Start (30 Lines)

```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConfirmGate, withConfirmToken } from 'mcp-confirm-gate';

const gate = createConfirmGate({ ttlMs: 120000 }); // 2-minute token TTL
const server = new Server({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });

// 1. Define base tool schema and enhance with confirmToken
const schema = withConfirmToken({
  type: 'object',
  properties: { id: { type: 'string', description: 'Record ID' } },
  required: ['id']
});

// 2. Wrap state-mutating handler
const deleteRecord = gate.wrap(
  'delete_record',
  (args) => `Permanently delete record ${args.id}?`,
  async ({ id }) => {
    await db.records.delete(id);
    return { content: [{ type: 'text', text: `Deleted record ${id}` }] };
  }
);

// 3. Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'delete_record', description: 'Deletes record with confirmation', inputSchema: schema }]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'delete_record') return await deleteRecord(req.params.arguments);
  throw new Error('Unknown tool');
});
```

---

## Threat Model

### What It Protects Against

- **Direct Unauthorized Execution**: An LLM agent cannot trigger a mutating tool on its first pass without prompting the user.
- **Fabricated Confirmations**: The token is signed using HMAC-SHA256 with a server secret (`crypto.randomBytes(32)` or injected secret). An LLM cannot forge or guess a valid confirmation token.
- **Argument Tampering / Parameter Hijacking**: The token is bound to a SHA-256 hash of the canonical JSON representation of the arguments (independent of JSON key order). If an agent attempts to alter arguments between the request and execution steps (e.g. changing `id: "rec_1"` to `id: "rec_all"`), the gate returns `args_mismatch`.
- **Token Replay Attacks**: Tokens are strictly single-use. Any secondary attempt to use the same token returns `reused`.
- **Stale Confirmations**: Tokens expire after `ttlMs` milliseconds (default: 2 minutes). Expired tokens return `expired`.
- **Cross-Tool Replay**: A token issued for `toolA` cannot be submitted to `toolB`. The tool name is part of the cryptographic signature.

### What It Does NOT Protect Against

- **Social Engineering of Approver**: If a human user is tricked into approving a malicious prompt without verifying the action description.
- **Compromised Server Secret**: If the signing secret is exposed, an attacker with server access could forge tokens.
- **Transport Security Breaches**: The library relies on underlying secure transport (HTTPS / TLS) for MCP communication.
- **Replay within In-Flight Races**: In high-concurrency stateless setups without atomic distributed stores, concurrent requests using the same token should use atomic CAS or Redis locks.

---

## Serverless & Stateless Deployments

In long-running Node processes, `mcp-confirm-gate` maintains token state using an in-memory `Map` by default.

For stateless environments (AWS Lambda, Cloudflare Workers, Vercel Functions):
1. **External Store Adapter**: Provide an injectable `store` interface `{ get, set, delete }` backed by Redis, DynamoDB, or Upstash:
   ```javascript
   const gate = createConfirmGate({
     secret: process.env.CONFIRM_GATE_SECRET,
     store: {
       get: async (k) => await redis.get(k),
       set: async (k, v) => await redis.set(k, JSON.stringify(v), 'PX', 120000),
       delete: async (k) => await redis.del(k)
     }
   });
   ```
2. **Stable Secret with Used-Nonce Store**: Provide a stable secret via environment variable (`process.env.CONFIRM_GATE_SECRET`). Because the token encodes the nonce, expiry, and HMAC signature over the tool and canonical args, stateless nodes can cryptographically verify tokens and only need to record used nonces to prevent replays.

---

## Reference User: SettleSight Alexa+

`mcp-confirm-gate` was extracted from real-world requirements in [SettleSight Alexa+](https://github.com/RyanDev1st/settlesight) (`products/settlesight`, commit `4af459c`), our primary entry for the Amazon Alexa+ Hackathon.

In SettleSight, voice and agent-driven workflows reconcile supplier invoices, handle dispute resolutions, and issue high-value PayPal settlement payouts. While conversational AI can analyze disparities, financial ledger overrides and fund disbursements cannot safely execute autonomously. `mcp-confirm-gate` guards financial settlement tools, providing Alexa and web interfaces with an ironclad, cryptographically verifiable human confirmation boundary before any funds transfer or database mutation takes place.

---

## API Reference

### `createConfirmGate(options)`

- `options.ttlMs` *(number, default: 120000)*: Lifetime of issued confirmation tokens in milliseconds.
- `options.secret` *(string | Buffer)*: Cryptographic secret for HMAC-SHA256. Defaults to `crypto.randomBytes(32)` per process.
- `options.now` *(function, default: Date.now)*: Injected timestamp generator.
- `options.store` *(object, default: new Map())*: Storage adapter implementing `{ get(key), set(key, value), delete(key) }`.
- `options.onAudit` *(function)*: Callback invoked on every lifecycle stage: `{ tool, argsHash, stage, reason, at }`.

### `gate.wrap(name, describeAction, handler)`

Wraps an async MCP tool handler `(args, extra) => Promise<CallToolResult>` with confirmation verification.

### `withConfirmToken(schema)`

Injects the optional `confirmToken: { type: 'string' }` property into any standard JSON schema object.

### `gate.audit`

Array of historical audit entries recorded during the gate's lifetime.

---

## License

MIT © 2026 [RyanDev1st](https://github.com/RyanDev1st)

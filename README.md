# Janee 🔐

**Secrets management for AI agents**

---

## The Problem

AI agents need API access to be useful. The current approach is to give them your keys and hope they behave.

- 🔓 Agents have full access to Stripe, Gmail, databases
- 📊 No audit trail of what was accessed or why
- 🚫 No kill switch when things go wrong
- 💉 One prompt injection away from disaster

---

## The Solution

Janee is a local proxy that sits between your AI agents and your APIs:

1. **Store your API keys** — encrypted locally in `~/.janee/`
2. **Run `janee serve`** — starts a local proxy
3. **Point your agent at the proxy** — `localhost:9119/<service>/...`
4. **Janee injects the real key** — agent never sees it
5. **Everything is logged** — full audit trail

**Your keys stay on your machine. Agents never see them. You stay in control.**

---

## Quick Start

### Install

```bash
npm install -g janee
```

### Initialize

```bash
janee init
```

### Add a service

```bash
janee add stripe --url https://api.stripe.com --key sk_live_xxx
```

### Start the proxy

```bash
janee serve
```

### Use it

```bash
# Instead of calling Stripe directly, call through Janee
curl http://localhost:9119/stripe/v1/balance

# Janee injects your real key, proxies the request, logs it
```

---

## Two Ways to Use Janee

### 1. HTTP Proxy

Point any HTTP client at `localhost:9119/<service>/...`:

```javascript
// Before
const stripe = new Stripe('sk_live_xxx');

// After
const stripe = new Stripe('unused', {
  host: 'localhost',
  port: 9119,
  protocol: 'http',
  basePath: '/stripe'
});
```

### 2. MCP Server (for AI agents)

Janee exposes an [MCP](https://modelcontextprotocol.io) server for agents that support it:

```bash
janee serve --mcp
```

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `list_services` | Discover available APIs and their policies |
| `execute` | Proxy an API request |
| `get_http_access` | Get credentials for HTTP proxy |

Agents discover what's available, then call APIs through Janee. Same audit trail, same protection.

---

## OpenClaw Integration

If you're using [OpenClaw](https://openclaw.ai), install the plugin for native tool support:

```bash
npm install -g janee
janee init
janee add stripe --url https://api.stripe.com --key sk_live_xxx

# Install the OpenClaw plugin
openclaw plugins install @openclaw/janee
```

Enable in your agent config:

```json5
{
  agents: {
    list: [{
      id: "main",
      tools: { allow: ["janee"] }
    }]
  }
}
```

Your agent now has these tools:

- `janee_list_services` — Discover available APIs
- `janee_execute` — Make API requests through Janee
- `janee_get_http_access` — Get HTTP proxy credentials

The plugin spawns `janee serve --mcp` automatically. All requests are logged to `~/.janee/logs/`.

**See [docs/OPENCLAW.md](docs/OPENCLAW.md) for full integration guide.**

---

## Configuration

Config lives in `~/.janee/config.yaml`:

```yaml
server:
  port: 9119

services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: sk_live_xxx  # encrypted at rest

  github:
    baseUrl: https://api.github.com
    auth:
      type: bearer
      key: ghp_xxx

capabilities:
  stripe:
    service: stripe
    ttl: 1h
    autoApprove: true

  stripe_sensitive:
    service: stripe
    ttl: 5m
    requiresReason: true
```

**Services** = Real APIs with real keys  
**Capabilities** = What agents can request, with policies

---

## CLI Reference

```bash
janee init              # Set up ~/.janee/
janee add <service>     # Add a service
janee list              # List configured services
janee serve             # Start HTTP proxy
janee serve --mcp       # Start MCP server
janee logs              # View audit log
janee logs -f           # Tail audit log
janee sessions          # List active sessions
janee revoke <id>       # Kill a session
janee remove <service>  # Remove a service
```

---

## How It Works

```
┌─────────────┐      ┌──────────┐      ┌─────────┐
│  AI Agent   │─────▶│  Janee   │─────▶│  Stripe │
│             │      │  Proxy   │      │   API   │
└─────────────┘      └──────────┘      └─────────┘
      │                   │
   No key           Injects key
                    + logs request
```

1. Agent calls `localhost:9119/stripe/v1/customers`
2. Janee looks up `stripe` config, decrypts the real key
3. Proxies request to `api.stripe.com` with real key
4. Logs: timestamp, service, method, path, status
5. Returns response to agent

Agent never touches the real key.

---

## Security

- **Encryption**: Keys stored with AES-256-GCM
- **Local only**: Proxy binds to localhost by default
- **Audit log**: Every request logged to `~/.janee/logs/`
- **Sessions**: Time-limited, revocable
- **Kill switch**: `janee revoke` or just stop the server

---

## Integrations

Works with any agent that can make HTTP requests or speak MCP:

- **OpenClaw** — Native plugin (`@openclaw/janee`) — [Guide](docs/OPENCLAW.md)
- **Claude Desktop** — MCP server
- **Cursor** — MCP server or HTTP proxy
- **LangChain** — HTTP proxy
- **Any HTTP client** — just change the base URL

---

## Roadmap

- [x] Local HTTP proxy
- [x] Encrypted key storage  
- [x] Audit logging
- [x] MCP server
- [x] Session management
- [ ] LLM adjudication (evaluate requests with AI)
- [ ] Policy engine (rate limits, allowlists)
- [ ] Cloud version (managed hosting)

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT

---

**Stop giving AI agents your keys. Start controlling access.** 🔐

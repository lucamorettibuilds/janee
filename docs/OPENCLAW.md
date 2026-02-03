# Using Janee with OpenClaw

OpenClaw agents can use Janee with minimal configuration changes.

---

## Why Janee + OpenClaw?

OpenClaw agents often need access to multiple APIs — Gmail, Stripe, databases, etc. Without Janee, the agent has direct access to all keys.

**With Janee:**
- Keys live in Janee (encrypted at rest)
- Agent proxies requests through `localhost:9119`
- Full audit trail of API access
- Kill switch: stop Janee or revoke sessions

---

## Setup

### 1. Install Janee

```bash
npm install -g janee
```

### 2. Initialize

```bash
janee init
```

Creates `~/.janee/` and generates a master encryption key.

### 3. Add Your Services

```bash
janee add stripe --url https://api.stripe.com --key sk_live_xxx
janee add gmail --url https://gmail.googleapis.com --key <token>
```

### 4. Start Janee

```bash
janee serve
```

### 5. Update OpenClaw Tool Configs

In your OpenClaw tools or skills that make API calls, change the base URL:

```yaml
# Before
stripe:
  baseUrl: https://api.stripe.com
  apiKey: sk_live_xxx

# After
stripe:
  baseUrl: http://localhost:9119/stripe
  apiKey: unused  # Janee injects the real key
```

That's it. The agent now proxies through Janee.

---

## Monitoring

Watch what your agent is doing in real-time:

```bash
janee logs -f
```

Output:
```json
{"ts":"2026-02-03T08:15:00Z","service":"stripe","method":"GET","path":"/v1/customers","status":200}
{"ts":"2026-02-03T08:15:05Z","service":"gmail","method":"GET","path":"/gmail/v1/users/me/messages","status":200}
```

Filter by service:

```bash
janee logs -f -s stripe
```

---

## Kill Switch

If your agent goes rogue:

```bash
# Stop all API access
janee revoke --all

# Or just stop the proxy
ctrl+c
```

No proxy = no API access.

---

## Multiple Agents

If you run multiple OpenClaw agents, they can share the same Janee instance. The audit log shows which requests came from which session.

For stricter separation, run separate Janee instances on different ports:

```bash
# Agent 1
janee serve --port 9119

# Agent 2  
janee serve --port 9120 --config ~/.janee/agent2/
```

---

## Capabilities

For fine-grained control, define capabilities with different policies:

```yaml
# ~/.janee/config.yaml
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

Agent requests `stripe` for normal operations (auto-approved), but `stripe_sensitive` for dangerous operations (must provide a reason, shorter session).

---

## MCP Integration

Once OpenClaw adds MCP client support, agents will be able to discover available services dynamically:

```bash
janee serve --mcp
```

The agent calls `list_services` to see what's available, then `execute` to make requests. Same protection, better DX.

---

## Example: Full Setup

```bash
# Install
npm install -g janee

# Initialize
janee init

# Add services
janee add stripe --url https://api.stripe.com --key sk_live_xxx
janee add gmail --url https://gmail.googleapis.com --key ya29.xxx
janee add github --url https://api.github.com --key ghp_xxx

# Start proxy
janee serve

# (In another terminal) Watch logs
janee logs -f
```

Then update your OpenClaw workspace to use `localhost:9119/<service>` as the base URL for each service.

---

**Questions?** Open an issue on GitHub.

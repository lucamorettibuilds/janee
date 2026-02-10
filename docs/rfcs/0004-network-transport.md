# RFC-0004: Network Transport for Containerized Agent Deployments

**Status:** Draft  
**Author:** Janus  
**Created:** 2026-02-10  
**Tracking Issue:** #28

## Summary

Add HTTP/SSE network transport support to `janee serve` and the OpenClaw plugin, enabling containerized agents to connect to a host-side Janee instance over the network instead of requiring Janee to be installed inside the container.

## Motivation

### The Problem: Containers Break the Current Architecture

**Current architecture (stdio-based):**
```
┌─────────────────────────────────────┐
│  Agent Process (OpenClaw)           │
│  ┌────────────────────────────────┐ │
│  │ janee-openclaw plugin          │ │
│  │ spawns: janee serve (stdio)    │ │
│  └────────────────────────────────┘ │
│                                     │
│  Requires: Janee installed locally  │
│           ~/.janee/config.yaml      │
└─────────────────────────────────────┘
```

This works fine when the agent runs directly on the host, but breaks in containerized deployments:

**Containerized agent:**
```
┌──────────────────────────────────────┐
│  Docker Container (agent)            │
│  - No access to host filesystem      │
│  - No Janee binary                   │
│  - No ~/.janee/config.yaml           │
│                                      │
│  To make it work, you must:          │
│  ✗ Install Janee inside container    │
│  ✗ Mount config (with secrets!) in   │
│  ✗ Defeats Janee's security model    │
└──────────────────────────────────────┘
```

### The Use Case

**User:** @mkoorn running OpenClaw in a hardened Docker container (Sysbox runtime)

**Requirements:**
- Read-only rootfs
- All capabilities dropped
- No host bind mounts (security)
- Agent should never see API keys or master key

**Desired architecture:**
```
┌─────────────────────────┐          ┌──────────────────────────┐
│  Host                   │          │  Docker Container        │
│                         │          │                          │
│  janee serve            │◄─────────┤  Agent (OpenClaw)        │
│  --transport http       │   HTTP   │  janee-openclaw plugin   │
│  --port 9100            │          │  config: {               │
│                         │          │    url: "http://host:9100"│
│  Has:                   │          │  }                       │
│  - Master key           │          │                          │
│  - Encrypted creds      │          │  Has:                    │
│  - ~/.janee/config.yaml │          │  - Nothing! (as intended)│
└─────────────────────────┘          └──────────────────────────┘
```

### Why This Matters

Containerized agent deployments are increasingly common:
- **Security hardening:** Least-privilege containers, no host filesystem access
- **Cloud deployments:** Agents run in Kubernetes pods, ECS tasks, etc.
- **Multi-agent systems:** Multiple agents sharing one Janee instance
- **Compliance:** Separation of secrets from compute (SOC2, PCI-DSS)

Janee's core value prop is "keep secrets out of the agent's environment" — but the current stdio-only transport forces you to put Janee (and thus all secrets) **into** the container.

## Design

### Goals

1. **Preserve stdio as default** — Don't break existing workflows
2. **Support HTTP/SSE transport** — Enable network-based connections
3. **Minimal API changes** — Leverage MCP SDK built-in transports
4. **Secure by default** — No auth initially (localhost-only), opt-in auth later

### MCP SDK Transport Support

The MCP SDK (v1.26.0) already includes multiple transport implementations:

**Server transports:**
- `StdioServerTransport` (current)
- `SSEServerTransport` (Server-Sent Events)
- `StreamableHTTPServerTransport` (HTTP streaming)
- `WebSocketServerTransport`

**Client transports:**
- `StdioClientTransport` (current)
- `SSEClientTransport`
- `StreamableHTTPClientTransport`
- `WebSocketClientTransport`

**Recommendation:** Start with **SSE** (Server-Sent Events):
- ✅ Built into MCP SDK
- ✅ Simple HTTP-based protocol
- ✅ Works through firewalls/proxies
- ✅ No websocket infrastructure required
- ✅ Unidirectional (server → client) with HTTP POST for requests

---

## Implementation

### Phase 1: Server-Side (`janee serve`)

#### CLI Changes

Add `--transport` and `--port` flags:

```bash
janee serve                                # stdio (default, unchanged)
janee serve --transport sse --port 9100    # SSE listener on :9100
janee serve --transport stdio              # explicit stdio
```

#### Code Changes

**In `src/cli/commands/serve-mcp.ts`:**

```typescript
import { Command } from 'commander';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { createMCPServer } from '../../core/mcp-server.js';

export function serveMCPCommand(program: Command): void {
  program
    .command('serve')
    .description('Start Janee MCP server')
    .option('-t, --transport <type>', 'Transport type (stdio|sse)', 'stdio')
    .option('-p, --port <number>', 'Port for network transport', '9100')
    .option('-h, --host <host>', 'Host to bind to', 'localhost')
    .action(async (options) => {
      const { transport, port, host } = options;

      // Create MCP server (logic unchanged)
      const mcpServer = createMCPServer({
        capabilities,
        services,
        sessionManager,
        auditLogger,
        onExecute,
        onReloadConfig
      });

      if (transport === 'sse') {
        // SSE transport - HTTP endpoint
        const app = express();
        app.use(express.json());

        const sseTransport = new SSEServerTransport('/mcp', app);
        await mcpServer.connect(sseTransport);

        app.listen(parseInt(port), host, () => {
          console.error(`Janee MCP server listening on http://${host}:${port}/mcp`);
        });
      } else {
        // Default: stdio transport (unchanged)
        const stdioTransport = new StdioServerTransport();
        await mcpServer.connect(stdioTransport);
        console.error('Janee MCP server started (stdio)');
      }
    });
}
```

**Dependencies to add:**
```json
{
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

---

### Phase 2: Client-Side (`janee-openclaw` plugin)

#### Plugin Config Schema

Add optional `url` field:

```json
{
  "id": "janee-openclaw",
  "name": "Janee",
  "configSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "Janee server URL (e.g., http://172.30.0.1:9100/mcp). Omit to use local stdio."
      }
    }
  }
}
```

#### Plugin Code Changes

**In `packages/openclaw-plugin/src/index.ts`:**

```typescript
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function createJaneeTools(context, config) {
  const { url } = config || {};

  let transport;
  if (url) {
    // Network transport: connect to remote Janee instance
    transport = new SSEClientTransport(new URL(url));
  } else {
    // Local transport: spawn janee serve as subprocess (current behavior)
    transport = new StdioClientTransport({
      command: 'janee',
      args: ['serve']
    });
  }

  const client = new Client({
    name: 'janee-openclaw',
    version: '0.3.0'
  }, {
    capabilities: {}
  });

  await client.connect(transport);

  // Rest unchanged: register janee_list_services, janee_execute, etc.
  // ...
}
```

---

## Example Usage

### Setup: Host-Side Janee

```bash
# On the host machine
npm install -g @true-and-useful/janee
janee init
janee add stripe --auth-type bearer --key sk_live_...

# Start Janee in network mode
janee serve --transport sse --port 9100 --host 0.0.0.0
# Janee MCP server listening on http://0.0.0.0:9100/mcp
```

### Setup: Containerized Agent

**Docker network:** Container can reach host on `172.30.0.1` (Docker bridge IP)

**OpenClaw config:**
```yaml
extensions:
  - id: janee-openclaw
    enabled: true
    config:
      url: "http://172.30.0.1:9100/mcp"
```

**Agent workflow:**
```
Agent: "List available services"
→ janee-openclaw calls janee_list_services over HTTP
→ Janee responds with ["stripe"]

Agent: "Get recent Stripe customers"
→ janee-openclaw calls janee_execute(capability: "stripe", path: "/v1/customers")
→ Janee proxies to Stripe API with decrypted key
→ Response returned to agent

Agent never sees the Stripe API key!
```

---

## Security Considerations

### Phase 1 Security Model (Localhost-Only)

**Default binding: `localhost`**
```bash
janee serve --transport sse  # binds to 127.0.0.1 only
```

**Trust model:**
- Same as current stdio: anyone who can connect is trusted
- Suitable for local Docker bridge networks (container → host)
- Not suitable for public networks (no auth yet)

### Phase 2: Authentication (Future)

Add `--auth-token` flag:

```bash
janee serve --transport sse --port 9100 --auth-token "secret-token-123"
```

Plugin config:
```yaml
config:
  url: "http://janee.example.com:9100/mcp"
  authToken: "secret-token-123"
```

**Implementation:**
- HTTP Bearer token authentication
- Validated on every request
- Token stored in Janee config (encrypted)
- Rotate via `janee config set auth-token`

**When to add auth:**
- If users want to expose Janee over public networks
- If Janee runs as a shared service (multi-agent systems)
- Not needed for localhost or trusted private networks

### Audit Logging

No changes needed — existing audit logger (`AuditLogger`) logs every request regardless of transport.

---

## Migration Path

### For Local Users (No Change Required)

```bash
# This continues to work exactly as before
janee serve  # stdio by default
```

OpenClaw plugin with no config still spawns `janee serve` as a subprocess.

### For Container Users (Opt-In)

**Step 1:** Start Janee on host
```bash
janee serve --transport sse --port 9100
```

**Step 2:** Configure plugin to connect over network
```yaml
extensions:
  - id: janee-openclaw
    config:
      url: "http://host.docker.internal:9100/mcp"  # or 172.30.0.1
```

**Step 3:** Agent connects to remote Janee (no secrets in container)

---

## Alternatives Considered

### Option 1: WebSocket Transport

**Pros:**
- Full duplex (bidirectional)
- Lower latency

**Cons:**
- Requires websocket infrastructure (reverse proxies, firewalls)
- Overkill for Janee's request-response pattern
- MCP's SSE transport already handles bidirectional via POST

**Decision:** Start with SSE (simpler), add WebSocket later if needed.

### Option 2: gRPC

**Pros:**
- Efficient binary protocol
- Strong typing

**Cons:**
- Not part of MCP SDK (custom implementation required)
- Adds complexity (protobuf, codegen)
- HTTP/SSE is simpler and sufficient

**Decision:** Stick with MCP SDK built-in transports.

### Option 3: Unix Domain Sockets

**Pros:**
- Fast local IPC
- No network ports

**Cons:**
- Doesn't work for container → host communication (need host bind mount)
- Defeats the purpose (no secrets in container)

**Decision:** Use network transports (HTTP/SSE).

---

## Testing Strategy

### Unit Tests

- Test `janee serve --transport sse` starts HTTP server
- Test `janee serve` defaults to stdio (backward compat)
- Test invalid transport types fail gracefully

### Integration Tests

- Spin up `janee serve --transport sse` in background
- Connect with SSE client
- Call `list_services`, `execute`, `reload_config`
- Verify responses match stdio behavior
- Verify audit logs are identical

### Manual Testing

- Docker container with OpenClaw
- Host-side Janee with network transport
- Agent successfully calls Janee tools over HTTP
- Verify secrets never enter container

---

## Rollout Plan

### v0.5.0 (Experimental)

- Add `--transport sse` support to `janee serve`
- Add `url` config to `janee-openclaw` plugin
- Document setup for Docker users
- Mark as experimental (subject to change)

### v0.6.0 (Stable)

- Gather feedback from container users
- Fix any issues discovered
- Add `--auth-token` support (if needed)
- Mark as stable, recommend for production

### v1.0.0

- Consider making SSE transport default for new installs
- Keep stdio for backward compatibility
- Add WebSocket transport (if demand exists)

---

## Open Questions

1. **Should we support TLS?**
   - Not initially — users can put Janee behind nginx/Caddy
   - Add native TLS if there's demand (`--cert`, `--key` flags)

2. **Should we support multiple transports simultaneously?**
   - E.g., `janee serve --transport stdio,sse --port 9100`
   - Probably overkill — start with one transport at a time

3. **What about HTTP request timeouts?**
   - MCP SDK handles this, but we should document expected latency
   - Long-running API calls (analytics queries, etc.) may hit client timeouts

4. **Should the plugin auto-detect host IP?**
   - Docker: `host.docker.internal` (macOS/Windows), `172.17.0.1` (Linux)
   - Too much magic — require explicit `url` config

---

## Success Metrics

- **Adoption:** Number of users running `janee serve --transport sse`
- **Container deployments:** GitHub issues mentioning Docker/Kubernetes
- **Security improvements:** Reduction in "secrets in container" support requests
- **Performance:** Request latency comparable to stdio (< 10ms overhead)

---

## Prior Art

- **MCP SDK examples:** [`ssePollingExample.js`](https://github.com/modelcontextprotocol/sdk/blob/main/src/examples/server/ssePollingExample.ts)
- **OpenClaw plugin docs:** Support for network-based MCP servers
- **1Password Connect:** Similar HTTP API for containerized secret access
- **HashiCorp Vault:** Agent mode vs. server mode (we're doing both)

---

## References

- Issue #28: https://github.com/rsdouglas/janee/issues/28
- MCP SDK docs: https://github.com/modelcontextprotocol/sdk
- SSE transport: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- Docker networking: https://docs.docker.com/network/

---

**Next Steps:**
1. Gather feedback from Ross and @mkoorn
2. Prototype SSE server in a branch
3. Test with OpenClaw in Docker
4. Refine based on findings
5. Merge and release as experimental in v0.5.0

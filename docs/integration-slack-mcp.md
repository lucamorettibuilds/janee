# Integrating Janee with Slack MCP Servers

This guide shows how to use Janee to manage Slack API tokens for MCP servers, keeping your workspace credentials secure while giving AI agents controlled access.

## Why Use Janee for Slack?

Slack tokens are sensitive:
- **`xoxb-` bot tokens** — Full bot permissions for your workspace
- **`xoxp-` user tokens** — Access to your personal DMs and channels

Without Janee, these tokens live in:
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@slack/mcp"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-actual-token-here"  // ❌ Exposed
      }
    }
  }
}
```

**Problems:**
- ❌ Token stored in plaintext config file
- ❌ Visible to any tool that reads MCP settings
- ❌ Could be included in Claude training data if read during conversation
- ❌ No audit trail of what the agent did with Slack access
- ❌ Can't revoke access without changing config files

**With Janee:**
- ✅ Token encrypted at rest in `~/.janee/`
- ✅ Agent never sees the actual token
- ✅ Full audit log of all Slack API calls
- ✅ Centralized management (one place to update/revoke)
- ✅ Works with multiple Slack workspaces

## Setup

### 1. Install Janee

```bash
npm install -g @true-and-useful/janee
janee init
```

### 2. Add Your Slack Token

**Option A: Interactive**
```bash
janee add
```

Then enter:
- Name: `slack-workspace`
- Base URL: `https://slack.com/api`
- Auth type: `bearer`
- Key: `xoxb-your-bot-token` (or `xoxp-` for user token)

**Option B: Command-line**
```bash
janee add slack-workspace \
  -u https://slack.com/api \
  -t bearer \
  -k xoxb-your-bot-token
```

### 3. Configure MCP Server to Use Janee

Instead of passing the token directly, configure your Slack MCP server to use Janee:

**For `@slack/mcp` or `jtalk22/slack-mcp-server`:**

```json
{
  "mcpServers": {
    "janee": {
      "command": "janee",
      "args": ["serve"]
    }
  }
}
```

Remove the `slack` server configuration — Janee handles it now.

### 4. Test It

```bash
janee serve
```

In Claude Desktop or your MCP client:
```
Can you list my recent Slack messages?
```

Claude will use Janee's `execute` tool:
```
execute(
  serviceName: "slack-workspace",
  method: "POST",
  endpoint: "/conversations.history",
  body: { channel: "C123ABC" }
)
```

Janee intercepts this, injects your real token, makes the API call, and returns the result.

## Usage Examples

### Read DMs and Channels

**Agent request:**
```typescript
execute({
  serviceName: "slack-workspace",
  method: "POST",
  endpoint: "/conversations.list",
  body: { types: "public_channel,private_channel,im" }
})
```

Janee automatically adds:
```
Authorization: Bearer xoxb-your-token
```

### Send a Message

```typescript
execute({
  serviceName: "slack-workspace", 
  method: "POST",
  endpoint: "/chat.postMessage",
  body: {
    channel: "C123ABC",
    text: "Message from AI agent"
  }
})
```

### Search Messages

```typescript
execute({
  serviceName: "slack-workspace",
  method: "POST",
  endpoint: "/search.messages",
  body: { query: "project deadline" }
})
```

## Multi-Workspace Setup

Managing multiple Slack workspaces? Add each one separately:

```bash
janee add work-slack -u https://slack.com/api -t bearer -k xoxb-work-token
janee add personal-slack -u https://slack.com/api -t bearer -k xoxb-personal-token
janee add client-workspace -u https://slack.com/api -t bearer -k xoxb-client-token
```

Now specify which workspace in each request:

```typescript
// Work messages
execute({ serviceName: "work-slack", ... })

// Personal messages  
execute({ serviceName: "personal-slack", ... })
```

## Audit Trail

Every Slack API call is logged:

```bash
janee logs slack-workspace
```

Output:
```
2026-02-12 13:45:23 | POST /conversations.list | 200 | 142ms
2026-02-12 13:45:31 | POST /conversations.history | 200 | 89ms  
2026-02-12 13:46:12 | POST /chat.postMessage | 200 | 234ms
```

See what the agent accessed and when.

## Security Benefits

### 1. Defense Against Privacy Concerns

Remember the [Anthropic issue #23852](https://github.com/anthropics/claude-code/issues/23852)? User discovered Claude read their MCP config file (with tokens) during a conversation, potentially exposing secrets to training data.

**With Janee:**
- Config file contains `janee serve`, not tokens
- Agent never sees actual Slack credentials
- Even if config is read, no sensitive data exposed

### 2. Token Rotation

Need to rotate your Slack token? Update once:

```bash
janee update slack-workspace -k xoxb-new-token
```

All agents automatically use the new token. No config file hunting.

### 3. Immediate Revocation

Suspect misuse? Kill access instantly:

```bash
janee disable slack-workspace
```

Or remove it completely:
```bash
janee remove slack-workspace
```

## Comparison: With vs Without Janee

| Aspect | Without Janee | With Janee |
|--------|---------------|------------|
| **Token storage** | Plaintext in config | Encrypted in `~/.janee/` |
| **Agent visibility** | Token fully visible | Agent never sees it |
| **Audit trail** | None | Full request log |
| **Multi-workspace** | Multiple config entries | One config, multiple services |
| **Token rotation** | Edit N config files | One command |
| **Privacy risk** | High (config can be read) | Low (no secrets in config) |
| **Revocation** | Edit configs, restart agents | `janee disable` |

## Advanced: JIT Provisioning (Future)

Janee is adding just-in-time token provisioning. Instead of storing long-lived Slack tokens:

1. Agent requests Slack access
2. Janee prompts: "Allow access to #general for 1 hour?"
3. You approve
4. Janee generates temporary scoped token
5. Token auto-expires

This will make Slack integrations even more secure.

## Troubleshooting

### "Service not found" Error

Make sure you added the service:
```bash
janee list
```

Should show `slack-workspace` or whatever you named it.

### Wrong Workspace Accessed

Double-check the `serviceName` parameter matches your configured service name:
```bash
janee list  # See exact names
```

### Rate Limiting

Slack has API rate limits. Janee passes through rate limit responses:
```
429 Too Many Requests
Retry-After: 60
```

Check logs:
```bash
janee logs slack-workspace | grep 429
```

## Related Resources

- [Slack API Documentation](https://api.slack.com/methods)
- [Slack MCP Server (jtalk22)](https://github.com/jtalk22/slack-mcp-server)
- [Slack MCP Server (korotovsky)](https://github.com/korotovsky/slack-mcp-server)  
- [MCP Secrets Management Guide](./mcp-secrets-guide.md)
- [Anthropic Privacy Issue #23852](https://github.com/anthropics/claude-code/issues/23852)

## Get Help

- **GitHub Issues**: [rsdouglas/janee/issues](https://github.com/rsdouglas/janee/issues)
- **General MCP Questions**: [modelcontextprotocol/discussions](https://github.com/modelcontextprotocol/servers/discussions)

---

**Next Steps:**
- [GitHub Integration Guide](./integration-github-mcp.md)
- [PostgreSQL Integration Guide](./integration-postgres-mcp.md)
- [Gmail Integration Guide](./integration-gmail-mcp.md)

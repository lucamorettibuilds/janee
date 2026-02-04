# Using Janee with Claude Code

This guide walks you through setting up Janee as an MCP server for [Claude Code](https://code.claude.com), Anthropic's coding CLI.

## Why use Janee with Claude Code?

Claude Code can interact with external APIs, but managing credentials is tricky:

- **Pasting API keys in prompts** — Keys end up in logs and model context
- **Environment variables** — Work but aren't portable or audited
- **Manual API calls** — Defeats the purpose of AI assistance

Janee solves this by:
- Storing credentials **encrypted at rest**
- Handling authentication **transparently** (Claude never sees raw keys)
- **Logging every request** for audit trails
- Supporting multiple services in one config

## Prerequisites

- [Claude Code](https://code.claude.com) installed
- [Node.js](https://nodejs.org) 18+ installed
- A terminal

## Step 1: Install Janee

```bash
npm install -g @true-and-useful/janee
```

Verify it's installed:

```bash
janee --version
```

## Step 2: Add a service

Let's add GitHub as an example:

```bash
janee add github
```

You'll be prompted for:
- **Base URL**: `https://api.github.com` (press Enter for default)
- **Auth type**: Select `bearer` or `api-key`
- **Token**: Paste your GitHub personal access token

Janee encrypts and stores this securely in `~/.janee/config.yaml`.

### Other services

```bash
# Stripe
janee add stripe --base-url https://api.stripe.com

# OpenAI
janee add openai --base-url https://api.openai.com

# Any REST API
janee add myservice --base-url https://api.example.com
```

## Step 3: Configure Claude Code

### Option A: CLI command (recommended)

```bash
claude mcp add janee --command janee --args serve --scope user
```

This adds Janee globally for all projects. Use `--scope project` for project-specific config.

### Option B: Edit config file directly

Edit `~/.claude.json` and add Janee to the `mcpServers` section:

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

If `janee` isn't in your PATH, use the full path:

```json
{
  "mcpServers": {
    "janee": {
      "command": "/usr/local/bin/janee",
      "args": ["serve"]
    }
  }
}
```

Find the full path with:
```bash
which janee
```

### Alternative: npx

If you prefer not to install globally:

```bash
claude mcp add janee --command npx --args @true-and-useful/janee,serve --scope user
```

Or in the config file:

```json
{
  "mcpServers": {
    "janee": {
      "command": "npx",
      "args": ["@true-and-useful/janee", "serve"]
    }
  }
}
```

## Step 4: Verify the connection

List your configured MCP servers:

```bash
claude mcp list
```

You should see `janee` in the list.

## Step 5: Test it

Start a Claude Code session and try:

```
> List my GitHub repositories
```

or

```
> Show me my recent GitHub notifications
```

Claude should use Janee to make the API call without you needing to provide credentials.

## Troubleshooting

### "Command not found" error

Claude Code can't find the `janee` executable. Either:
1. Use the full path in the config
2. Ensure Node.js bin directory is in your PATH

### MCP server not appearing

```bash
# Check your config
claude mcp list

# Re-add if needed
claude mcp remove janee
claude mcp add janee --command janee --args serve --scope user
```

### Authentication errors

```bash
# Re-add the service with correct credentials
janee remove github
janee add github
```

### Check Janee logs

Janee logs all requests for debugging:

```bash
janee logs
janee logs -f  # tail mode
```

## Example: GitHub workflow

Once configured, you can ask Claude things like:

- "Create a new issue in my-repo titled 'Bug fix needed'"
- "Show me open PRs in organization/repo"
- "What are my assigned issues?"

Claude will use Janee to authenticate with GitHub automatically.

## Example: Stripe workflow

```bash
janee add stripe --base-url https://api.stripe.com/v1
# Enter your Stripe secret key when prompted
```

Then ask:
- "List my recent Stripe customers"
- "Show me the last 5 charges"
- "Create a customer with email test@example.com"

## Security notes

- Credentials are encrypted using your system keychain where available
- Janee never sends credentials to AI models — only the API responses
- All requests are logged for audit purposes (including request bodies as of v0.3.0)
- You can revoke access anytime with `janee remove <service>`

## Next steps

- [Add more services](/docs/services.md)
- [Configure audit logging](/docs/audit.md)
- [Use with Cursor](/docs/cursor.md)
- [Use with Codex CLI](/docs/codex.md)

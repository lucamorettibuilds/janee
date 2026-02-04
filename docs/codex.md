# Using Janee with Codex CLI

This guide walks you through setting up Janee as an MCP server for [Codex CLI](https://developers.openai.com/codex/cli/), OpenAI's coding agent.

## Why use Janee with Codex CLI?

Codex CLI can interact with external APIs, but managing credentials is tricky:

- **Pasting API keys in prompts** — Keys end up in logs and model context
- **Environment variables** — Work but aren't portable or audited
- **Manual API calls** — Defeats the purpose of AI assistance

Janee solves this by:
- Storing credentials **encrypted at rest**
- Handling authentication **transparently** (Codex never sees raw keys)
- **Logging every request** for audit trails
- Supporting multiple services in one config

## Prerequisites

- [Codex CLI](https://developers.openai.com/codex/cli/) installed
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

## Step 3: Configure Codex CLI

Codex CLI uses TOML for MCP configuration. Edit `~/.codex/config.toml`:

```toml
[mcp_servers.janee]
command = "janee"
args = ["serve"]
```

If `janee` isn't in your PATH, use the full path:

```toml
[mcp_servers.janee]
command = "/usr/local/bin/janee"
args = ["serve"]
```

Find the full path with:
```bash
which janee
```

### Alternative: npx

If you prefer not to install globally:

```toml
[mcp_servers.janee]
command = "npx"
args = ["@true-and-useful/janee", "serve"]
```

### Configuration is shared

The MCP configuration is shared between Codex CLI and the Codex IDE extension. Configure once, use in both.

## Step 4: Verify the connection

Start Codex and check that Janee is connected:

```bash
codex
```

You should see Janee's tools available in the session.

## Step 5: Test it

In a Codex session, try:

```
> List my GitHub repositories
```

or

```
> Show me my recent GitHub notifications
```

Codex should use Janee to make the API call without you needing to provide credentials.

## Troubleshooting

### "Command not found" error

Codex can't find the `janee` executable. Either:
1. Use the full path in config.toml
2. Ensure Node.js bin directory is in your PATH

### MCP server not connecting

1. Check that `config.toml` is valid TOML (watch for quoting issues)
2. Verify the file location: `~/.codex/config.toml`
3. Restart Codex completely

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

Once configured, you can ask Codex things like:

- "Create a new issue in my-repo titled 'Bug fix needed'"
- "Show me open PRs in organization/repo"
- "What are my assigned issues?"

Codex will use Janee to authenticate with GitHub automatically.

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
- [Use with Claude Code](/docs/claude-code.md)

# Integrating Janee with GitHub MCP Servers

Manage GitHub personal access tokens (PATs) securely while giving AI agents access to repositories, issues, and pull requests.

## Why Use Janee for GitHub?

GitHub tokens grant powerful access:
- **Classic PATs** — Full repo access, can push code, delete branches
- **Fine-grained PATs** — Scoped but still sensitive  
- **OAuth tokens** — User identity and permissions

Storing these in MCP config files is risky:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_abc123..."  // ❌ Exposed
      }
    }
  }
}
```

**With Janee:**
- ✅ PAT encrypted at rest
- ✅ Agent never sees the token
- ✅ Audit trail of all GitHub API calls
- ✅ Easy rotation when compromised
- ✅ Support multiple GitHub accounts

## Quick Setup

### 1. Install Janee

```bash
npm install -g @true-and-useful/janee
janee init
```

### 2. Create GitHub Personal Access Token

Go to https://github.com/settings/tokens and create a token with scopes you need:
- `repo` — Full repository access
- `read:org` — Read organization data
- `workflow` — Manage GitHub Actions
- etc.

Copy the token (starts with `ghp_` or `github_pat_`)

### 3. Add Token to Janee

```bash
janee add github \
  -u https://api.github.com \
  -t bearer \
  -k ghp_your_token_here
```

Or interactively:
```bash
janee add
# Name: github
# URL: https://api.github.com  
# Auth type: bearer
# Key: ghp_...
```

### 4. Configure MCP

Replace your GitHub MCP server config with Janee:

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

### 5. Test

```bash
janee serve
```

Ask Claude:
```
Can you list my GitHub repositories?
```

## Usage Examples

### List Repositories

```typescript
execute({
  serviceName: "github",
  method: "GET",
  endpoint: "/user/repos",
  queryParams: { sort: "updated", per_page: 10 }
})
```

### Create an Issue

```typescript
execute({
  serviceName: "github",
  method: "POST",
  endpoint: "/repos/owner/repo/issues",
  body: {
    title: "Bug: Login button not working",
    body: "Users report 500 error when clicking login",
    labels: ["bug", "priority:high"]
  }
})
```

### Comment on Pull Request

```typescript
execute({
  serviceName: "github",
  method: "POST",
  endpoint: "/repos/owner/repo/issues/123/comments",
  body: {
    body: "LGTM! Nice refactor 🎉"
  }
})
```

### Search Issues

```typescript
execute({
  serviceName: "github",
  method: "GET",
  endpoint: "/search/issues",
  queryParams: { 
    q: "repo:owner/repo is:open label:bug",
    sort: "created",
    order: "desc"
  }
})
```

## Multi-Account Setup

Working with multiple GitHub accounts?

```bash
# Personal account
janee add github-personal -u https://api.github.com -t bearer -k ghp_personal_token

# Work account  
janee add github-work -u https://api.github.com -t bearer -k ghp_work_token

# Client account
janee add github-client -u https://api.github.com -t bearer -k ghp_client_token
```

Specify which account per request:

```typescript
// Personal repos
execute({ serviceName: "github-personal", ... })

// Work repos
execute({ serviceName: "github-work", ... })
```

## Security Benefits

### Token Never Leaves Your Machine

Even when agent reads your MCP config, it only sees:
```json
{
  "janee": { "command": "janee", "args": ["serve"] }
}
```

No exposed `ghp_` token.

### Full Audit Trail

See every API call:

```bash
janee logs github
```

Output:
```
2026-02-12 14:23:11 | GET /user/repos | 200 | 234ms
2026-02-12 14:23:45 | POST /repos/acme/app/issues | 201 | 567ms
2026-02-12 14:24:12 | GET /repos/acme/app/pulls/42 | 200 | 123ms
```

Catch suspicious activity immediately.

### Easy Rotation

Token compromised? Update once:

```bash
janee update github -k ghp_new_token
```

All agents instantly use the new token.

### Immediate Revocation

```bash
janee disable github  # Temporarily disable
janee remove github   # Completely remove
```

## Common Patterns

### Listing Organization Repos

```typescript
execute({
  serviceName: "github",
  method: "GET", 
  endpoint: "/orgs/your-org/repos",
  queryParams: { type: "all", sort: "pushed" }
})
```

### Creating a Branch

```typescript
// 1. Get latest commit SHA
execute({
  serviceName: "github",
  method: "GET",
  endpoint: "/repos/owner/repo/git/refs/heads/main"
})

// 2. Create new branch
execute({
  serviceName: "github",
  method: "POST",
  endpoint: "/repos/owner/repo/git/refs",
  body: {
    ref: "refs/heads/feature-branch",
    sha: "abc123..."  // From step 1
  }
})
```

### Merging a Pull Request

```typescript
execute({
  serviceName: "github",
  method: "PUT",
  endpoint: "/repos/owner/repo/pulls/123/merge",
  body: {
    commit_title: "Merge feature: Add dark mode",
    merge_method: "squash"
  }
})
```

## Integration with GitHub MCP Servers

Janee works alongside popular GitHub MCP servers:

### Official GitHub Server
```bash
npm install -g @modelcontextprotocol/server-github
```

No env vars needed — Janee provides credentials.

### Custom GitHub Servers

If you built a custom GitHub MCP server, have it use Janee's `execute` tool instead of managing tokens directly.

**Before:**
```typescript
// Your server manages token
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
```

**After:**
```typescript
// Let Janee manage token
tools.execute({
  serviceName: "github",
  method: "GET",
  endpoint: "/user/repos"
})
```

## Troubleshooting

### "Bad credentials" Error

Token expired or revoked. Update it:
```bash
janee update github -k ghp_new_token
```

### Rate Limiting

GitHub has strict rate limits (5000 req/hour for authenticated). Check:

```bash
janee logs github | grep 403
```

Janee passes through rate limit headers:
```
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 234
X-RateLimit-Reset: 1644523456
```

### Wrong Repository Access

Verify your PAT has the required scopes:
```bash
# Check scopes via GitHub API
execute({
  serviceName: "github",
  method: "GET",
  endpoint: "/user"
})
# Response headers include: X-OAuth-Scopes
```

If missing scopes, regenerate token with correct permissions.

## Best Practices

1. **Use Fine-Grained PATs** — Limit scope to specific repos
2. **Set Expiration** — Force token rotation every 90 days
3. **Monitor Logs** — Regular `janee logs github` checks
4. **Separate Accounts** — Don't use same PAT for personal/work
5. **Revoke on Suspicious Activity** — `janee disable github` immediately

## Related Resources

- [GitHub REST API Docs](https://docs.github.com/en/rest)
- [Creating Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token)
- [MCP GitHub Server](https://github.com/modelcontextprotocol/servers/tree/main/src/github)
- [Janee Secrets Guide](./mcp-secrets-guide.md)

## Get Help

- **GitHub Issues**: [rsdouglas/janee/issues](https://github.com/rsdouglas/janee/issues)
- **MCP Discussions**: [modelcontextprotocol/discussions](https://github.com/modelcontextprotocol/servers/discussions)

---

**More Integration Guides:**
- [Slack Integration](./integration-slack-mcp.md)
- [PostgreSQL Integration](./integration-postgres-mcp.md)
- [Stripe Integration](./integration-stripe-mcp.md)

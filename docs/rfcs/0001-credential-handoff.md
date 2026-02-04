# RFC 0001: Credential Handoff Mode

**Status:** Proposed (Under Revision)  
**Author:** Janee Agent  
**Date:** 2026-02-04  
**Updated:** 2026-02-04 (added wrapper execution alternative)

## Summary

Add support for tools that can't be proxied (CLIs, browser auth, native SDKs). Two approaches under consideration:

1. **Direct handoff** - Agent requests actual credential, receives it with injected instructions. Simple but breaks core security property (agent sees key) and causes credentials-in-logs issues.

2. **Wrapper execution** (potentially better) - Janee executes commands with credentials injected via env, agent sees output but never the key. Preserves core security property while enabling CLI usage.

This RFC explores both approaches. Wrapper execution might be the right answer.

## Motivation

Janee's proxy model works great for HTTP APIs - agent never sees the real key, we enforce policies, everything's logged. But some tools can't be proxied:

- **CLIs** - Tools like `bird` (Twitter CLI) need credentials in config files or env vars
- **Browser automation** - Login flows require entering credentials directly
- **Native SDKs** - Some libraries expect raw keys, don't support custom HTTP clients
- **OAuth flows** - Need client secrets to complete authorization

Current alternatives all suck:
- Putting keys in `.env` files means no audit trail, no revocation, no control
- Asking the human every time breaks agent autonomy
- Not supporting these tools means huge blind spots in automation

We need a **harm reduction** approach: give the agent the credential when necessary, but with guardrails.

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
    mode: handoff  # New: vs default 'proxy'
    requiresReason: true  # Optional: agent must explain why
    requiresApproval: false  # Optional: human approval required
    expiresAfter: 3600  # Optional: handoff session expires (seconds)
```

### API Surface

New MCP tool: `janee_request_credential`

**Input:**
```json
{
  "service": "twitter",
  "reason": "Need to use bird CLI to search mentions and post reply",
  "capability": "twitter_cli"  // Optional: if multiple handoff caps exist
}
```

**Output:**
```json
{
  "service": "twitter",
  "credential": "xoxb-actual-key-here",
  "sessionId": "hs_7f8a3bc9e2",
  "expiresAt": 1707034545,
  "instructions": "This credential is temporary. Do not persist to disk, share with external services, or include in logs. Use only for the stated purpose. Session expires in 1 hour."
}
```

### What Gets Logged

Every handoff creates an audit entry:

```json
{
  "timestamp": "2026-02-04T05:55:45Z",
  "type": "credential_handoff",
  "service": "twitter",
  "capability": "twitter_cli",
  "reason": "Need to use bird CLI to search mentions and post reply",
  "sessionId": "hs_7f8a3bc9e2",
  "expiresAt": 1707034545,
  "approved": true,
  "approvedBy": "auto"  // or "human" if manual approval
}
```

### Session Management

- Handoff creates a temporary session tracked in `~/.janee/handoff-sessions.json`
- Agent should call `janee_revoke_handoff(sessionId)` when done (honor system)
- Sessions auto-expire based on `expiresAfter` config
- `janee sessions` shows active handoff sessions
- `janee revoke --session hs_xxx` manually revokes

### Optional: Approval Flow

If `requiresApproval: true`:

1. Agent calls `janee_request_credential`
2. Janee prompts human: "Agent requests Twitter credential for: 'Need to use bird CLI...'. Approve? (y/n)"
3. Human approves/denies
4. Credential returned or error thrown

For non-interactive environments (cron jobs, etc.), approval can be pre-granted via session config.

## Tradeoffs & Limitations

### This Is Harm Reduction, Not Perfect Security

Once the agent has the credential, it **can** still:
- Persist it to disk
- Share it with external services
- Use it beyond stated purpose
- Ignore expiration

We're relying on:
1. **Injected instructions** - LLM is prompted not to misuse it
2. **Audit trail** - We know when handoffs happen
3. **Revocation** - Human can revoke sessions manually (but agent still has the key in context)
4. **Expiration** - This is **ornamental** - once the key is in the agent's context, "expiration" doesn't actually revoke access. It's an audit checkpoint and psychological signal, not real security.

This is **way better than `.env` files** (no audit, no revocation, no expiration) but **not as secure as proxy mode** (agent never sees key).

### The Credentials-in-Logs Problem

Returning credentials as tool results means they end up in:
- Agent transcripts (session history)
- Debug logs (if enabled)
- Framework logs (depending on MCP client)

Even with "don't persist" instructions, the credential appears in log files by virtue of being a tool response. This is a **significant** security issue - logs get backed up, shared for debugging, stored indefinitely.

This might be an anti-pattern. See "Wrapper Execution Mode" alternative below for a better approach.

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

### 1. Wrapper Execution Mode (Potentially Better Approach)

Instead of handing the credential to the agent, Janee **executes the command** with credentials injected:

```bash
# Agent calls this tool:
janee_exec(service="twitter", command=["bird", "tweet", "Hello world"])

# Janee runs:
TWITTER_API_KEY=<real-key> bird tweet "Hello world"

# Agent sees stdout/stderr but never sees the key
```

**Advantages:**
- **Agent never sees the credential** - preserves Janee's core security property
- **No credentials in logs** - tool response is command output, not the key
- **Works for most CLIs** - they read from env vars or stdin
- **Still auditable** - we log command + service, just not the key itself

**Challenges:**
- Some CLIs write credentials to config files (e.g., `~/.birdrc`)
- Agent can't inspect the key for debugging
- Requires careful env isolation (don't leak to other processes)
- Some tools need interactive input (but we can handle with stdin piping)

**Config example:**
```yaml
capabilities:
  twitter_cli:
    service: twitter
    mode: exec  # vs 'handoff' or 'proxy'
    allowCommands: ["bird"]  # Whitelist executables
    env:
      TWITTER_API_KEY: "{{credential}}"  # Template
```

**This might be the right answer.** It keeps "agent never sees key" intact while enabling CLI usage. Should prototype this before committing to direct handoff.

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

**Problem:** Most CLIs don't support fetching keys from URLs. Would need to build a wrapper script per CLI.

### 4. Just use `.env` files

**Problem:** No audit trail, no revocation, no expiration, credentials persist across sessions. We'd be building a secrets manager that doesn't manage secrets.

### 5. Only support browser automation (Playwright, Puppeteer)

**Problem:** Doesn't help with CLIs, native SDKs, OAuth flows. Too narrow.

### 6. Require human approval for every handoff

**Problem:** Breaks agent autonomy. If the human has to approve every CLI invocation, why have an agent?

Approval should be **optional** based on risk tolerance. Low-risk services (read-only APIs) can auto-approve; high-risk services (financial APIs) can require approval.

### 7. Build a credential proxy that intercepts CLI config files

**Problem:** Every CLI has different config formats. Unmaintainable. Also very fragile (what if CLI updates its config schema?).

### 8. Don't support these tools at all

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

# RFC 0001: Credential Handoff Mode

**Status:** Proposed  
**Author:** Janee Agent  
**Date:** 2026-02-04

## Summary

Add a `handoff` capability mode that allows agents to request actual credentials for tools that can't be proxied (CLIs, browser auth, native SDKs). The agent receives the key plus injected instructions not to persist or share it. All handoffs are logged and audited. Optional approval gates available for high-risk services.

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
3. **Revocation** - Human can revoke sessions manually
4. **Expiration** - Sessions auto-expire

This is **way better than `.env` files** (no audit, no revocation, no expiration) but **not as secure as proxy mode** (agent never sees key).

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

### 1. Just use `.env` files

**Problem:** No audit trail, no revocation, no expiration, credentials persist across sessions. We'd be building a secrets manager that doesn't manage secrets.

### 2. Only support browser automation (Playwright, Puppeteer)

**Problem:** Doesn't help with CLIs, native SDKs, OAuth flows. Too narrow.

### 3. Require human approval for every handoff

**Problem:** Breaks agent autonomy. If the human has to approve every CLI invocation, why have an agent?

Approval should be **optional** based on risk tolerance. Low-risk services (read-only APIs) can auto-approve; high-risk services (financial APIs) can require approval.

### 4. Build a credential proxy that intercepts CLI config files

**Problem:** Every CLI has different config formats. Unmaintainable. Also very fragile (what if CLI updates its config schema?).

### 5. Don't support these tools at all

**Problem:** Leaves huge gaps in agent capabilities. Twitter automation is a common use case, can't just ignore it.

## Implementation Plan

### Phase 1: Core Handoff (MVP)
- [ ] Add `mode: handoff` to capability config
- [ ] Implement `janee_request_credential` MCP tool
- [ ] Add handoff audit logging
- [ ] Session tracking in `~/.janee/handoff-sessions.json`
- [ ] `janee sessions` lists handoff sessions
- [ ] `janee revoke --session` manual revocation

### Phase 2: Approval Flow
- [ ] Add `requiresApproval: true` config option
- [ ] Interactive approval prompt (CLI)
- [ ] Pre-approval for non-interactive contexts

### Phase 3: Advanced Features
- [ ] `expiresAfter` session expiration
- [ ] Auto-revocation on expiry
- [ ] `requiresReason: true` enforcement
- [ ] Handoff usage analytics (how often, which services, etc.)

## Open Questions

1. **Should we inject instructions into the agent's prompt or just include them in the response?**
   - Prompt injection is more reliable (agent sees it before using key)
   - Response-only is simpler (no framework integration needed)

2. **Should handoff sessions be capability-scoped or service-scoped?**
   - Capability-scoped: more granular, agent specifies intent
   - Service-scoped: simpler, one session per service

3. **Should we support key rotation during active handoff sessions?**
   - Useful for long-running sessions
   - Adds complexity (agent needs to handle credential updates)

## Success Metrics

- Handoff mode enables Twitter automation (bird CLI)
- Audit logs show when/why credentials were handed off
- Human can revoke handoff sessions manually
- Zero credential leaks to logs or external services (honor system, but we can check audit logs for misuse patterns)

---

**Next Steps:** Implement Phase 1 (core handoff) and test with Twitter CLI use case.

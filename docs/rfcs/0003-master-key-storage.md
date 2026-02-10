# RFC-0003: Master Key Storage Alternatives

**Status:** Draft  
**Author:** Janus  
**Created:** 2026-02-10  
**Tracking Issue:** #24

## Summary

Evaluate alternatives to storing the master encryption key in plaintext in `config.yaml`, considering OS keychain integration, external KMS, and password-derived keys while preserving Janee's simplicity and ease of deployment.

## Motivation

### The Current Model

Janee uses a "keychain" model for secrets management:
- One master key (32 bytes, base64-encoded) stored in `config.yaml`
- All service credentials encrypted with AES-256-GCM using the master key
- Config file permissions: `0600` (user-readable only)

Example:
```yaml
version: '0.2.0'
masterKey: 'mY+sEcReTkEy1234567890abcdefghijklmnopqrstuv='  # ← plaintext
server:
  port: 9119
  host: localhost
services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: 'encrypted:aGVsbG8gd29ybGQ...'  # ← encrypted
```

### The Security Concern

**Risk:** If `config.yaml` is leaked (git commit, backup, screen share, etc.), all secrets are compromised because the master key is stored alongside the encrypted values.

**Mitigations in place:**
- File permissions (`0600`) prevent other users on the same system
- Users are advised not to commit config files
- Janee is designed for single-user local development (not multi-tenant)

**From @mkoorn's audit (issue #14):**
> "Master key stored in plaintext alongside encrypted secrets in config.yaml. While config file has restrictive permissions (0600), the key itself is not encrypted at rest. This is a known limitation until the upstream npm bug is fixed."

### Why This Matters

As Janee grows, users may:
- Run it on shared systems (CI runners, dev servers)
- Store configs in dotfiles repos
- Use it for production workloads (agents managing real infrastructure)
- Want enterprise-grade key management

The current model is pragmatic for local dev but may not scale to all use cases.

## Design Options

### Option 1: OS Keychain Integration (Recommended)

Store the master key in the operating system's secure credential storage instead of `config.yaml`.

**Implementation:**
- **macOS:** Keychain Access via `security` CLI
- **Windows:** Credential Manager via `cmdkey` CLI
- **Linux:** Secret Service API (GNOME Keyring, KWallet) via `libsecret`

**Config change:**
```yaml
version: '0.3.0'
masterKey:
  type: keychain
  service: janee
  account: main
server:
  port: 9119
  # ...
```

**Behavior:**
1. On first run after migration, prompt user to store key in keychain
2. At runtime, retrieve key from keychain instead of config file
3. If keychain access fails, prompt user (never fall back to plaintext)

**Pros:**
- ✅ Master key never touches disk in plaintext
- ✅ Leverages OS-level encryption (FileVault, BitLocker, etc.)
- ✅ Familiar security model (same as SSH keys, browser passwords)
- ✅ No external dependencies (cloud, network)

**Cons:**
- ❌ Platform-specific implementation required
- ❌ Breaks portability (can't copy config to new machine and run)
- ❌ Requires user interaction on first run (can't automate fully)
- ❌ Linux support fragmented (multiple secret services)

**Migration path:**
```bash
janee migrate keychain
# Prompts: "Store master key in macOS Keychain? [y/n]"
# On yes: stores key, updates config.yaml, removes plaintext key
```

---

### Option 2: Password-Derived Key

Derive the master key from a user password at runtime instead of storing it.

**Config change:**
```yaml
version: '0.3.0'
masterKey:
  type: password
  salt: 'random-salt-generated-once'
  iterations: 600000  # PBKDF2 iterations
server:
  port: 9119
  # ...
```

**Behavior:**
1. On startup, prompt user for password
2. Derive 32-byte key using PBKDF2-HMAC-SHA256 with salt
3. Use derived key to decrypt service credentials
4. If wrong password, decryption fails (caught by strict mode)

**Pros:**
- ✅ No key stored on disk at all
- ✅ Platform-independent
- ✅ Simple implementation (crypto module built-in)
- ✅ Familiar model (like SSH key passphrases)

**Cons:**
- ❌ Breaks unattended operation (can't start without user present)
- ❌ User must remember password (no recovery if forgotten)
- ❌ Annoying for local dev (type password every time)
- ❌ Doesn't work for long-running daemons

**Use case:** High-security manual workflows, not suitable for always-on agents.

---

### Option 3: External KMS (Cloud Key Management)

Store the master key in a cloud KMS (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault).

**Config change:**
```yaml
version: '0.3.0'
masterKey:
  type: kms
  provider: aws
  keyId: 'arn:aws:kms:us-east-1:123456789:key/abc-def'
  region: us-east-1
server:
  port: 9119
  # ...
```

**Behavior:**
1. At runtime, call KMS API to decrypt a data key
2. Use decrypted key to decrypt service credentials
3. Cache decrypted key in memory (not on disk)

**Pros:**
- ✅ Enterprise-grade key management
- ✅ Audit trail (KMS logs every key access)
- ✅ Fine-grained access control (IAM policies)
- ✅ Key rotation supported

**Cons:**
- ❌ Requires cloud account and network access
- ❌ Introduces external dependency (Janee won't start if KMS down)
- ❌ Cost (KMS API calls aren't free)
- ❌ Overkill for local dev
- ❌ Defeats Janee's "works offline" design goal

**Use case:** Production deployments in cloud environments, not suitable for local dev.

---

### Option 4: Hybrid (Plaintext with Optional Upgrade)

Keep plaintext master key as default, allow opt-in upgrades to keychain/password/KMS.

**Config:**
```yaml
version: '0.3.0'
masterKey: 'plaintext-key'  # default, works everywhere
# OR
masterKey:
  type: keychain
  service: janee
  account: main
# OR
masterKey:
  type: password
  salt: '...'
server:
  port: 9119
  # ...
```

**Behavior:**
- New users get plaintext by default (easy onboarding)
- `janee migrate keychain` upgrades to OS keychain
- `janee migrate password` upgrades to password-derived
- Each mode has clear trade-offs documented

**Pros:**
- ✅ Preserves simplicity for default case
- ✅ Power users can opt into stronger security
- ✅ No breaking changes
- ✅ Migration path for existing users

**Cons:**
- ❌ Most users will stick with plaintext (defaults matter)
- ❌ More code to maintain (three key storage modes)
- ❌ Documentation complexity

---

## Recommendation

**Ship Option 1 (OS Keychain) in v0.5.0 as opt-in, keep plaintext as default.**

**Rationale:**
1. **Addresses the security concern** without breaking existing workflows
2. **Platform-appropriate security** — leverages OS features most users already trust
3. **No external dependencies** — works offline, no cloud required
4. **Clear upgrade path** — `janee migrate keychain` for users who want it
5. **Preserves simplicity** — default behavior unchanged

**Phased rollout:**
- **v0.5.0:** Add keychain support as opt-in (plaintext still default)
- **v0.6.0:** Warn on `janee init` that plaintext is less secure, suggest keychain
- **v1.0.0:** Consider making keychain the default (with fallback to plaintext if unavailable)

### Implementation Checklist

- [ ] macOS keychain support via `security` CLI
- [ ] Windows Credential Manager support via `cmdkey`
- [ ] Linux Secret Service support via `libsecret` (if feasible)
- [ ] `janee migrate keychain` command
- [ ] `janee test keychain` command (verify keychain access works)
- [ ] Update docs with security trade-offs
- [ ] Add warning in `janee init` output

### Out of Scope (for now)

- Password-derived keys (too disruptive for unattended operation)
- Cloud KMS (overkill for local dev, breaks offline usage)
- Encrypted config files (doesn't solve the key distribution problem)

## Security Considerations

### Threat Model

**What we're protecting against:**
- Config file accidentally committed to git
- Config file in backups (Time Machine, cloud sync)
- Config file visible in screen shares
- Other users on shared systems reading the file

**What we're NOT protecting against:**
- Malware running as the user (can access keychain anyway)
- Physical access to unlocked machine (can read memory)
- Root/admin access (can bypass all OS-level protections)

### Trade-offs

| Model | Security | Usability | Portability | Automation |
|-------|----------|-----------|-------------|------------|
| Plaintext | ⚠️ Low | ✅ High | ✅ High | ✅ High |
| Keychain | ✅ Medium | ✅ High | ❌ Low | ✅ High |
| Password | ✅✅ High | ❌ Low | ✅ High | ❌ None |
| KMS | ✅✅✅ Highest | ⚠️ Medium | ❌ None | ✅ High |

**Conclusion:** Keychain strikes the best balance for Janee's use case (local dev tool that should also work for production agents).

## Open Questions

1. **Linux fragmentation:** How do we handle systems without libsecret? Fall back to plaintext with warning?
2. **Recovery:** If user loses keychain access, how do they recover? Keep encrypted backup of master key in config?
3. **Multi-machine:** How do users run Janee on multiple machines? Export/import keychain entry?
4. **Docker/containers:** Keychain doesn't work in containers. Document env var approach (`JANEE_MASTER_KEY`)?

## Prior Art

- **Git credential helpers:** Support OS keychain + plaintext fallback
- **AWS CLI:** Supports credential file + keychain + env vars
- **1Password CLI:** Requires keychain integration, no plaintext option
- **Age encryption:** File-based keys, relies on file permissions

## References

- Issue #24: https://github.com/rsdouglas/janee/issues/24
- Security audit: https://github.com/rsdouglas/janee/issues/14
- macOS Keychain docs: https://support.apple.com/guide/keychain-access/
- libsecret docs: https://wiki.gnome.org/Projects/Libsecret

---

**Next Steps:**
1. Gather feedback from Ross and community
2. Test keychain integration on macOS (prototype)
3. Research Linux secret service APIs
4. Draft implementation plan for v0.5.0

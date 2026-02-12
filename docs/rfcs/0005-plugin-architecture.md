# RFC 0005: Secrets Provider Plugin Architecture

**Status:** Proposed  
**Author:** Luca Moretti (@lucamorettibuilds)  
**Date:** 2026-02-12  
**Updated:** 2026-02-12 (Specification Refinement)  
**Related Issue:** [#54](https://github.com/rsdouglas/janee/issues/54)

## Summary

Add a plugin architecture to support multiple secrets management backends (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, etc.) instead of only filesystem-based encrypted storage. This enables Janee to integrate with existing enterprise secrets infrastructure while maintaining its core security properties.

New configuration: `providers` block that defines secrets backends with type-specific configuration. Service keys can reference providers using a URI-style syntax: `provider://path/to/secret`.

## Motivation

Janee currently stores encrypted secrets on the local filesystem. This works well for individual developers and small teams, but creates friction for enterprise adoption:

**Current limitations:**
- No integration with existing secrets infrastructure (Vault, AWS, Azure, GCP)
- Secrets must be copied/duplicated into Janee's local storage
- No centralized rotation or auditing through enterprise systems
- Bootstrap problem: how do you securely provision Janee's master key?

**Enterprise requirements:**
- Secrets already exist in Vault/AWS/Azure
- Security teams mandate centralized secrets management
- Compliance requires audit trails from secrets backend
- Secrets rotation happens at the provider level

**Solution:** Make Janee's secrets backend pluggable. Support local filesystem storage (current behavior) PLUS external providers. Each service can choose its provider, or mix providers for different services.

## Design

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Janee Core                           │
│  (MCP Server, Auth Proxy, Audit, Policy Enforcement)   │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │  Secrets Manager   │  (abstraction layer)
         │  Interface         │
         └────────┬───────────┘
                  │
    ┌─────────────┼─────────────┬─────────────────┐
    │             │             │                 │
    ▼             ▼             ▼                 ▼
┌──────────┐ ┌──────────┐ ┌──────────┐     ┌──────────┐
│ Local FS │ │ HashiCorp│ │   AWS    │ ... │  Azure   │
│ Provider │ │  Vault   │ │ Secrets  │     │   Key    │
│(default) │ │ Provider │ │ Manager  │     │  Vault   │
└──────────┘ └──────────┘ └──────────┘     └──────────┘
```

## Normative Behavior

This section defines mandatory implementation requirements.

### URI Format and Parsing

**Grammar:**

```
secret-uri     = provider-ref "://" secret-path
provider-ref   = ALPHA *(ALPHA / DIGIT / "-" / "_")
secret-path    = path-segment *("/" path-segment)
path-segment   = 1*(unreserved / pct-encoded)
unreserved     = ALPHA / DIGIT / "-" / "." / "_" / "~"
pct-encoded    = "%" HEXDIG HEXDIG
```

**Validation Rules:**

1. **Provider reference**: 
   - Must start with letter
   - 1-64 characters
   - Only alphanumeric, hyphen, underscore
   - Case-insensitive (normalized to lowercase)
   - Reserved names: `local`, `filesystem` (alias for default provider)

2. **Secret path**:
   - Must not be empty
   - Max length: 1024 characters (after URL decoding)
   - Must not contain `..` segments (path traversal prevention)
   - Leading slash is optional and normalized away
   - Trailing slash is stripped

3. **URL encoding**:
   - Special characters must be percent-encoded
   - Decode before passing to provider
   - Invalid encoding → `InvalidSecretURI` error

**Examples:**

```yaml
# Valid
key: vault://mcp/agents/stripe/api-key
key: aws://prod/payment/stripe
key: vault://my-app/config%2Fspecial  # Decodes to "my-app/config/special"

# Invalid
key: vault://                 # Error: empty path
key: vault://../etc/passwd   # Error: path traversal
key: 9vault://path           # Error: provider must start with letter
key: vault://very/long/...   # Error: path > 1024 chars
```

### Error Taxonomy

All provider operations must use this error taxonomy:

```typescript
enum SecretErrorCode {
  // Configuration errors (fail fast at startup)
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',           // Unknown provider name
  PROVIDER_CONFIG_INVALID = 'PROVIDER_CONFIG_INVALID', // Bad provider config
  INVALID_SECRET_URI = 'INVALID_SECRET_URI',           // Malformed URI
  
  // Runtime errors (per-request)
  SECRET_NOT_FOUND = 'SECRET_NOT_FOUND',               // Secret doesn't exist
  PROVIDER_AUTH_FAILED = 'PROVIDER_AUTH_FAILED',       // Auth credentials invalid/expired
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',       // Network/connection error
  PROVIDER_PERMISSION_DENIED = 'PROVIDER_PERMISSION_DENIED', // Insufficient permissions
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',     // Too many requests
  
  // Internal errors
  PROVIDER_INTERNAL_ERROR = 'PROVIDER_INTERNAL_ERROR', // Provider-specific failure
}

class SecretError extends Error {
  constructor(
    public code: SecretErrorCode,
    message: string,
    public provider?: string,
    public path?: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'SecretError';
  }
}
```

**Error Handling Requirements:**

1. **Fail fast**: Configuration errors (PROVIDER_NOT_FOUND, INVALID_SECRET_URI) must be detected at startup
2. **No fallback**: Never silently fall back to another provider on error
3. **Clear messages**: Include provider name and sanitized path (no secret values)
4. **Categorization**: Distinguish transient (UNAVAILABLE, RATE_LIMITED) from permanent (AUTH_FAILED, NOT_FOUND) errors
5. **Logging**: Log errors with full context, but redact secret values


### Authentication Lifecycle

**Initialization:**

```typescript
interface ProviderAuthConfig {
  method: string;  // Provider-specific auth method
  // Additional fields depend on method (see strict schema below)
}

interface SecretsProvider {
  /**
   * Initialize must:
   * 1. Validate configuration
   * 2. Establish connection
   * 3. Authenticate
   * 4. Verify permissions (optional health check)
   * 
   * Throws SecretError with PROVIDER_CONFIG_INVALID or PROVIDER_AUTH_FAILED
   */
  initialize(): Promise<void>;
}
```

**Token Refresh and Renewal:**

1. **Automatic renewal**: Providers with expiring tokens (Vault, AWS STS) must handle renewal transparently
2. **Renewal timing**: Refresh at 80% of token lifetime (e.g., 48min for 1hr token)
3. **Renewal failure**: Log warning, attempt retry with exponential backoff
4. **Hard expiration**: If renewal fails and token expires, subsequent requests fail with `PROVIDER_AUTH_FAILED`

**Retry and Backoff Strategy:**

```typescript
interface RetryPolicy {
  maxAttempts: number;      // Default: 3
  initialDelayMs: number;   // Default: 100ms
  maxDelayMs: number;       // Default: 5000ms
  backoffMultiplier: number; // Default: 2.0
  retryableErrors: SecretErrorCode[]; // Default: [PROVIDER_UNAVAILABLE, PROVIDER_RATE_LIMITED]
}
```

**Retry behavior:**

1. **Transient errors** (UNAVAILABLE, RATE_LIMITED): Retry with exponential backoff
2. **Permanent errors** (AUTH_FAILED, NOT_FOUND, PERMISSION_DENIED): Fail immediately, no retry
3. **Rate limiting**: Honor `Retry-After` header if provided by backend
4. **Circuit breaker**: After 5 consecutive failures, pause requests for 30s
5. **Timeout**: Per-request timeout of 10s (configurable)

**Auth failure propagation:**

```typescript
// When auth fails during initialization
throw new SecretError(
  SecretErrorCode.PROVIDER_AUTH_FAILED,
  `Failed to authenticate with Vault: token expired`,
  'prodVault'
);

// When auth fails during request
throw new SecretError(
  SecretErrorCode.PROVIDER_AUTH_FAILED,
  `Vault token expired mid-request`,
  'prodVault',
  'mcp/agents/stripe/api-key'
);
```

### Configuration Schema

**Strict provider configuration with discriminated unions:**

```typescript
type ProviderConfig = 
  | LocalFilesystemConfig
  | HashicorpVaultConfig
  | AwsSecretsManagerConfig
  | AzureKeyVaultConfig;

interface LocalFilesystemConfig {
  type: 'filesystem';
  path: string;  // Required: absolute or ~ path
  // No additional fields allowed
}

interface HashicorpVaultConfig {
  type: 'hashicorp-vault';
  address: string;        // Required: https://vault.example.com
  namespace?: string;     // Optional: for Vault Enterprise
  auth: VaultAuthConfig;  // Required: see below
  mountPath?: string;     // Optional: KV mount path, default: "secret"
  // Forbidden fields will cause PROVIDER_CONFIG_INVALID error
}

type VaultAuthConfig =
  | { method: 'token'; token: string }
  | { method: 'approle'; roleId: string; secretId: string }
  | { method: 'kubernetes'; role: string; serviceAccountPath?: string }
  | { method: 'aws'; role: string; region?: string };

interface AwsSecretsManagerConfig {
  type: 'aws-secrets-manager';
  region: string;         // Required: us-east-1, etc.
  auth: AwsAuthConfig;    // Required
  // No endpoint override in v1 (use standard AWS endpoints)
}

type AwsAuthConfig =
  | { method: 'iam-role' }  // Use instance/pod IAM role
  | { method: 'access-key'; accessKeyId: string; secretAccessKey: string };

interface AzureKeyVaultConfig {
  type: 'azure-key-vault';
  vaultUrl: string;       // Required: https://<vault-name>.vault.azure.net
  auth: AzureAuthConfig;  // Required
}

type AzureAuthConfig =
  | { method: 'managed-identity'; clientId?: string }
  | { method: 'service-principal'; tenantId: string; clientId: string; clientSecret: string };
```

**Configuration validation:**

1. **Strict mode**: Unknown fields → `PROVIDER_CONFIG_INVALID` error
2. **Required fields**: Missing required field → error at startup
3. **Type checking**: Wrong type (e.g., number instead of string) → error at startup
4. **Secret substitution**: Support `${ENV_VAR}` and `${file:/path}` in auth fields

**Example with strict validation:**

```yaml
providers:
  prodVault:
    type: hashicorp-vault
    address: https://vault.company.com
    namespace: mcp-agents
    auth:
      method: approle
      roleId: ${VAULT_ROLE_ID}
      secretId: ${file:~/.vault-secret-id}
    mountPath: secret
    # unknownField: value  # This would cause PROVIDER_CONFIG_INVALID error
```

### Provider Fallback Policy

**Hard requirement: NO FALLBACK**

```typescript
// ❌ FORBIDDEN: Attempting fallback on error
async function getSecret(uri: string): Promise<string> {
  try {
    return await primaryProvider.getSecret(path);
  } catch (error) {
    // NEVER DO THIS - security risk
    return await fallbackProvider.getSecret(path);
  }
}

// ✅ CORRECT: Fail fast with clear error
async function getSecret(uri: string): Promise<string> {
  const result = await provider.getSecret(path);
  if (result === null) {
    throw new SecretError(
      SecretErrorCode.SECRET_NOT_FOUND,
      `Secret not found: ${uri}`,
      providerName,
      path
    );
  }
  return result;
}
```

**Rationale:**
- Fallback creates ambiguity about which provider is authoritative
- Security policies may differ between providers
- Audit trail becomes unclear
- Makes debugging harder

**If multiple providers needed:** User must explicitly configure separate services or use different URIs.


### V1 Scope: Read-Only Runtime

**Explicit constraints for version 1:**

```typescript
interface SecretsProvider {
  readonly name: string;
  readonly type: string;
  
  // ✅ REQUIRED in v1
  initialize(): Promise<void>;
  getSecret(path: string): Promise<string | null>;
  dispose(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
  
  // ❌ DEFERRED to v2 (optional in interface, but not implemented)
  setSecret?(path: string, value: string): Promise<void>;
  deleteSecret?(path: string): Promise<void>;
  listSecrets?(prefix?: string): Promise<string[]>;
}
```

**V1 limitations:**

1. **Runtime operations**: Read-only (`getSecret` only)
2. **Write operations**: Deferred to v2 (`setSecret`, `deleteSecret` not implemented)
3. **List operations**: Deferred to v2 (`listSecrets` not implemented)
4. **CLI mutations**: Use provider-native tools (Vault CLI, AWS CLI)

**Rationale:**
- Writing secrets is security-sensitive and varies by provider
- Most enterprises manage secret creation separately from consumption
- Read-only scope reduces attack surface
- Simplifies initial implementation

**V2 roadmap:**
- CLI commands: `janee secret set`, `janee secret delete`, `janee secret list`
- Safety features: dry-run mode, confirmation prompts
- Audit: Log all write operations
- Provider permissions: Require explicit write grants

## Security Threat Model

### Threats and Mitigations

**1. Server-Side Request Forgery (SSRF)**

*Threat:* Attacker provides malicious provider address to exfiltrate data.

```yaml
# Malicious config
providers:
  evil:
    type: hashicorp-vault
    address: http://169.254.169.254/latest/meta-data  # AWS metadata endpoint
```

*Mitigations:*
- Validate provider address format (must be valid URL)
- Block private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
- Block localhost (127.0.0.0/8, ::1)
- Require HTTPS for remote providers (HTTP only allowed for localhost dev mode)
- DNS rebinding protection: resolve hostname once, cache result
- Configuration is controlled by operator (not user input)

**2. Path Traversal / Secret Path Injection**

*Threat:* Attacker manipulates path to access unintended secrets.

```yaml
# Malicious attempt
key: vault://../../../etc/passwd
key: vault://prod/../../sensitive
```

*Mitigations:*
- Strict URI parsing (see grammar above)
- Reject `..` segments in path
- Normalize paths (remove redundant slashes, trailing slashes)
- Provider-specific path validation (e.g., Vault rejects relative paths)
- Least privilege: Configure providers with minimal read permissions

**3. Credential Leakage via Logs**

*Threat:* Secret values or provider credentials appear in logs.

*Mitigations:*
- **Never log secret values**
- Redact credentials in logs (show `token=***` not actual token)
- Log redaction for error messages (sanitize before logging)
- Separate audit logs for secret access (structured, secure storage)
- Log only: `{provider, path, timestamp, success/failure}`, never values

**4. Token/Credential Theft from Config**

*Threat:* Provider auth credentials stored in plaintext config.

*Mitigations:*
- Environment variable substitution: `${VAULT_TOKEN}`
- File references: `${file:~/.vault-token}`
- System keychain integration (future: macOS Keychain, Windows Credential Manager)
- File permissions: Warn if config file is world-readable
- Kubernetes: Use secrets/configmaps for provider credentials

**5. Man-in-the-Middle (MitM)**

*Threat:* Attacker intercepts traffic to secrets provider.

*Mitigations:*
- Require HTTPS/TLS for remote providers
- Certificate validation (reject self-signed unless explicitly allowed)
- Optional: Certificate pinning for high-security environments
- Mutual TLS support for Vault/AWS (provider-specific)

**6. Insufficient Provider Permissions**

*Threat:* Provider has overly broad access, violates least privilege.

*Mitigations:*
- Documentation: Guide users to configure minimal permissions
- Vault: Use policies to restrict path access
- AWS: Use IAM policies with specific resource ARNs
- Azure: Use RBAC with specific secret permissions
- Health check: Test permissions at startup

### Log Redaction Requirements

**What to log:**
```json
{
  "timestamp": "2026-02-12T14:25:00Z",
  "level": "info",
  "event": "secret_accessed",
  "provider": "prodVault",
  "path": "mcp/agents/stripe/api-key",
  "success": true,
  "latencyMs": 45
}
```

**What NOT to log:**
```json
{
  "secret_value": "sk_live_xxxx",  // ❌ NEVER
  "vault_token": "hvs.xxxxx",      // ❌ NEVER
  "aws_secret_access_key": "xxx"   // ❌ NEVER
}
```

**Redaction patterns:**
- Token values: Show `token=***`
- URIs with credentials: Redact before logging
- Error messages from providers: Sanitize before propagating

## Configuration Examples

### Production Vault Setup

```yaml
providers:
  prodVault:
    type: hashicorp-vault
    address: https://vault.company.com
    namespace: mcp-production
    auth:
      method: kubernetes
      role: janee-prod
      serviceAccountPath: /var/run/secrets/kubernetes.io/serviceaccount/token
    mountPath: secret

services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: prodVault://mcp/agents/stripe/api-key
```

### AWS with IAM Role

```yaml
providers:
  awsProd:
    type: aws-secrets-manager
    region: us-east-1
    auth:
      method: iam-role  # Uses ECS task role or EC2 instance profile

services:
  github:
    baseUrl: https://api.github.com
    auth:
      type: bearer
      key: awsProd://prod/mcp-agents/github-token
```

### Multi-Environment Setup

```yaml
providers:
  local:
    type: filesystem
    path: ~/.janee/credentials
  
  devVault:
    type: hashicorp-vault
    address: http://localhost:8200
    auth:
      method: token
      token: ${VAULT_DEV_TOKEN}
  
  prodVault:
    type: hashicorp-vault
    address: https://vault.company.com
    namespace: production
    auth:
      method: approle
      roleId: ${VAULT_ROLE_ID}
      secretId: ${file:/run/secrets/vault-secret-id}

services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: ${JANEE_ENV == 'prod' ? 'prodVault' : 'devVault'}://mcp/agents/stripe/api-key
```


## Implementation Plan

### Phase 1: Core Abstraction (Week 1)

**Goals:**
- Define `SecretsProvider` interface
- Extract current filesystem logic into `LocalProvider`
- Implement provider registry and initialization
- Add URI parsing and validation

**Deliverables:**
```typescript
// src/secrets/providers/interface.ts
export interface SecretsProvider {
  readonly name: string;
  readonly type: string;
  initialize(): Promise<void>;
  getSecret(path: string): Promise<string | null>;
  dispose(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}

// src/secrets/manager.ts
export class SecretsManager {
  private providers = new Map<string, SecretsProvider>();
  
  registerProvider(name: string, provider: SecretsProvider): void;
  async getSecret(uri: string): Promise<string>;
  parseURI(uri: string): { provider: string; path: string };
}

// src/secrets/providers/local.ts
export class LocalFilesystemProvider implements SecretsProvider {
  // Refactor existing code
}
```

**Tests:**
- URI parsing (valid/invalid cases)
- Provider registration and lookup
- Error taxonomy validation
- Local provider functionality (existing tests adapted)

### Phase 2: HashiCorp Vault Provider (Week 2)

**Goals:**
- Implement Vault provider with KV v2 support
- Support multiple auth methods (token, AppRole, Kubernetes)
- Token renewal and automatic refresh
- Comprehensive error handling

**Dependencies:**
```bash
npm install node-vault
```

**Implementation:**
```typescript
// src/secrets/providers/vault.ts
export class VaultProvider implements SecretsProvider {
  private client: any;
  private renewalTimer?: NodeJS.Timeout;
  
  async initialize(): Promise<void> {
    // Authenticate and start token renewal
  }
  
  async getSecret(path: string): Promise<string | null> {
    // Fetch from KV v2: /v1/{mountPath}/data/{path}
  }
  
  private async renewToken(): Promise<void> {
    // Automatic token renewal at 80% lifetime
  }
}
```

**Tests:**
- Vault integration tests (use testcontainers)
- Auth method variations
- Token renewal logic
- Error scenarios (connection failure, auth expired, not found)

### Phase 3: AWS Secrets Manager Provider (Week 3)

**Goals:**
- Implement AWS provider using AWS SDK v3
- Support IAM role and access key auth
- Handle AWS-specific errors (throttling, regions)

**Dependencies:**
```bash
npm install @aws-sdk/client-secrets-manager
```

**Implementation:**
```typescript
// src/secrets/providers/aws.ts
export class AwsSecretsManagerProvider implements SecretsProvider {
  private client: SecretsManagerClient;
  
  async getSecret(path: string): Promise<string | null> {
    const command = new GetSecretValueCommand({ SecretId: path });
    const response = await this.client.send(command);
    return response.SecretString || null;
  }
}
```

**Tests:**
- AWS integration tests (use LocalStack)
- IAM role auth (mock STS)
- Rate limiting and retry logic
- Cross-region scenarios

### Phase 4: Azure Key Vault Provider (Week 4)

**Goals:**
- Implement Azure provider using Azure SDK
- Support managed identity and service principal auth
- Handle Azure-specific pagination and errors

**Dependencies:**
```bash
npm install @azure/keyvault-secrets @azure/identity
```

**Implementation:**
```typescript
// src/secrets/providers/azure.ts
export class AzureKeyVaultProvider implements SecretsProvider {
  private client: SecretClient;
  
  async getSecret(path: string): Promise<string | null> {
    const secret = await this.client.getSecret(path);
    return secret.value || null;
  }
}
```

**Tests:**
- Azure integration tests (use Azurite or mock)
- Managed identity simulation
- Error scenarios specific to Azure

### Phase 5: Documentation and Migration (Week 5)

**Goals:**
- Comprehensive documentation
- Migration guide from filesystem-only
- Security best practices guide
- Example configurations for common scenarios

**Deliverables:**
- `docs/providers/README.md` - Overview and concepts
- `docs/providers/vault.md` - Vault setup and auth
- `docs/providers/aws.md` - AWS setup and IAM policies
- `docs/providers/azure.md` - Azure setup and RBAC
- `docs/migration/provider-migration.md` - Step-by-step migration
- Example configs in `examples/providers/`

### Testing Strategy

**Unit Tests:**
- URI parsing and validation (100% coverage)
- Error handling and taxonomy
- Provider configuration validation
- Retry and backoff logic

**Integration Tests:**
```typescript
describe('VaultProvider Integration', () => {
  let vault: StartedTestContainer;
  let provider: VaultProvider;
  
  beforeAll(async () => {
    vault = await new GenericContainer('vault:1.15')
      .withExposedPorts(8200)
      .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: 'test-token' })
      .start();
    
    provider = new VaultProvider({
      type: 'hashicorp-vault',
      address: `http://localhost:${vault.getMappedPort(8200)}`,
      auth: { method: 'token', token: 'test-token' }
    });
    
    await provider.initialize();
  });
  
  it('should fetch existing secret', async () => {
    // Setup test secret in Vault
    // Verify getSecret returns correct value
  });
  
  it('should return null for non-existent secret', async () => {
    const result = await provider.getSecret('nonexistent/path');
    expect(result).toBeNull();
  });
});
```

**E2E Tests:**
- Full Janee server with different provider configurations
- Multi-service, multi-provider scenarios
- Error recovery and retry behavior
- Performance under load

### Rollout Plan

**Phase 1: Alpha (Internal Testing)**
- Feature flag: `JANEE_PROVIDERS_ALPHA=true`
- Limited to development environments
- Gather feedback on API ergonomics

**Phase 2: Beta (Early Adopters)**
- Documented in changelog as beta feature
- Opt-in via config: `features: { providers: true }`
- Community testing with Vault/AWS/Azure
- Bug fixes and API refinements

**Phase 3: GA (General Availability)**
- Remove feature flag
- Enabled by default
- Backward compatibility: No `providers` block = filesystem provider
- Announce in release notes and community channels

## Backward Compatibility

### Seamless Migration Path

**Current config (filesystem only):**
```yaml
services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: stripe-api-key  # Implicit: stored in ~/.janee/credentials
```

**Behavior after plugin architecture:**
- If NO `providers` block exists: Use implicit filesystem provider
- Secret key without `://` → Resolve from default filesystem provider
- Existing installations continue to work without changes

**Explicit filesystem provider:**
```yaml
providers:
  default:
    type: filesystem
    path: ~/.janee/credentials

services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: default://stripe-api-key  # Explicit provider reference
```

### Migration Steps

**Step 1: Validate current setup**
```bash
janee config validate
# Output: Using default filesystem provider for all services
```

**Step 2: Add provider config (no behavior change yet)**
```yaml
providers:
  local:
    type: filesystem
    path: ~/.janee/credentials
  
  prodVault:
    type: hashicorp-vault
    address: https://vault.company.com
    auth:
      method: token
      token: ${VAULT_TOKEN}

services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: stripe-api-key  # Still uses filesystem (no :// syntax)
```

**Step 3: Migrate secrets one service at a time**
```bash
# Copy secret to Vault
vault kv put secret/mcp/agents/stripe api-key=<value>

# Update config
services:
  stripe:
    baseUrl: https://api.stripe.com
    auth:
      type: bearer
      key: prodVault://mcp/agents/stripe/api-key  # Now uses Vault
```

**Step 4: Verify and cleanup**
```bash
# Test service access
janee service test stripe

# Once confirmed, remove from filesystem
janee secret delete stripe-api-key --provider local
```

## Open Questions

1. **Caching strategy**: Should providers cache secrets in memory? 
   - Pro: Reduces latency and provider load
   - Con: Secrets may become stale, longer exposure window
   - **Proposal**: Optional TTL-based cache (default: no cache)

2. **Secret versioning**: Should we support version/pinning?
   ```yaml
   key: vault://path/to/secret@v5  # Specific version
   ```
   - Pro: Reproducibility, rollback capability
   - Con: Complexity, not all providers support versions
   - **Proposal**: Defer to v2, always fetch latest in v1

3. **Dynamic configuration reload**: Should provider config changes reload without restart?
   - Pro: Zero-downtime config updates
   - Con: Complex state management, auth token lifecycle
   - **Proposal**: Require restart for provider config changes in v1

4. **Observability**: Metrics for provider operations?
   - Request count, latency, error rate per provider
   - Secret access patterns (what gets accessed, how often)
   - **Proposal**: Add Prometheus metrics in v1

## Alternatives Considered

### Alternative 1: Single Multi-Backend Provider

Instead of multiple provider plugins, one universal provider with backend parameter:

```yaml
secrets:
  backend: vault
  config:
    address: https://vault.company.com
```

**Rejected because:**
- Doesn't support mixing providers (some services use Vault, others AWS)
- Configuration becomes deeply nested and hard to validate
- Can't easily add new backends without core changes

### Alternative 2: Sidecar Pattern

Run separate secrets-provider sidecar processes that Janee talks to via gRPC:

```yaml
providers:
  vault:
    type: grpc
    address: localhost:9000  # Vault provider sidecar
```

**Rejected because:**
- Added operational complexity (deploy/manage multiple processes)
- Network boundary adds latency
- Over-engineering for current needs
- Can revisit if we need language-agnostic providers

### Alternative 3: Environment Variable Only

Force all secrets to come from environment variables, no direct provider integration:

```yaml
services:
  stripe:
    auth:
      key: ${STRIPE_API_KEY}  # Must be in env
```

**Rejected because:**
- Shifts secret management burden entirely to user
- Doesn't solve enterprise integration problem
- Environment variables have size limits and poor lifecycle management
- Can't leverage provider features (rotation, audit trails)

## Success Metrics

**Adoption:**
- % of Janee installations using non-filesystem providers (target: 30% within 6 months)
- Number of community-contributed provider plugins (target: 2+ within 1 year)

**Reliability:**
- Provider error rate < 0.1%
- Auth renewal success rate > 99.9%
- Zero secret leaks via logs or errors

**Performance:**
- Secret fetch latency p95 < 100ms (Vault), < 200ms (AWS/Azure)
- Startup time with providers < 5s
- Memory overhead per provider < 10MB

## References

- [HashiCorp Vault API Docs](https://developer.hashicorp.com/vault/api-docs)
- [AWS Secrets Manager API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/)
- [Azure Key Vault REST API](https://learn.microsoft.com/en-us/rest/api/keyvault/)
- [OpenBao](https://openbao.org/) - Open source Vault fork (future consideration)
- [External Secrets Operator](https://external-secrets.io/) - K8s reference architecture

---

**Document Status:** Ready for review  
**Next Steps:**
1. Review by @rsdouglas and core maintainers
2. Community feedback period (2 weeks)
3. Finalize specification
4. Begin Phase 1 implementation

: prodVault://mcp/agents/stripe/api-key  # Now uses Vault
```

**Step 4: Verify and cleanup**
```bash
# Test service access
janee service test stripe

# Once confirmed, remove from filesystem
janee secret delete stripe-api-key --provider local
```

## Open Questions

1. **Caching strategy**: Should providers cache secrets in memory? 
   - Pro: Reduces latency and provider load
   - Con: Secrets may become stale, longer exposure window
   - **Proposal**: Optional TTL-based cache (default: no cache)

2. **Secret versioning**: Should we support version/pinning?
   ```yaml
   key: vault://path/to/secret@v5  # Specific version
   ```
   - Pro: Reproducibility, rollback capability
   - Con: Complexity, not all providers support versions
   - **Proposal**: Defer to v2, always fetch latest in v1

3. **Dynamic configuration reload**: Should provider config changes reload without restart?
   - Pro: Zero-downtime config updates
   - Con: Complex state management, auth token lifecycle
   - **Proposal**: Require restart for provider config changes in v1

4. **Observability**: Metrics for provider operations?
   - Request count, latency, error rate per provider
   - Secret access patterns (what gets accessed, how often)
   - **Proposal**: Add Prometheus metrics in v1

## Alternatives Considered

### Alternative 1: Single Multi-Backend Provider

Instead of multiple provider plugins, one universal provider with backend parameter:

```yaml
secrets:
  backend: vault
  config:
    address: https://vault.company.com
```

**Rejected because:**
- Doesn't support mixing providers (some services use Vault, others AWS)
- Configuration becomes deeply nested and hard to validate
- Can't easily add new backends without core changes

### Alternative 2: Sidecar Pattern

Run separate secrets-provider sidecar processes that Janee talks to via gRPC:

```yaml
providers:
  vault:
    type: grpc
    address: localhost:9000  # Vault provider sidecar
```

**Rejected because:**
- Added operational complexity (deploy/manage multiple processes)
- Network boundary adds latency
- Over-engineering for current needs
- Can revisit if we need language-agnostic providers

### Alternative 3: Environment Variable Only

Force all secrets to come from environment variables, no direct provider integration:

```yaml
services:
  stripe:
    auth:
      key: ${STRIPE_API_KEY}  # Must be in env
```

**Rejected because:**
- Shifts secret management burden entirely to user
- Doesn't solve enterprise integration problem
- Environment variables have size limits and poor lifecycle management
- Can't leverage provider features (rotation, audit trails)

## Success Metrics

**Adoption:**
- % of Janee installations using non-filesystem providers (target: 30% within 6 months)
- Number of community-contributed provider plugins (target: 2+ within 1 year)

**Reliability:**
- Provider error rate < 0.1%
- Auth renewal success rate > 99.9%
- Zero secret leaks via logs or errors

**Performance:**
- Secret fetch latency p95 < 100ms (Vault), < 200ms (AWS/Azure)
- Startup time with providers < 5s
- Memory overhead per provider < 10MB

## References

- [HashiCorp Vault API Docs](https://developer.hashicorp.com/vault/api-docs)
- [AWS Secrets Manager API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/)
- [Azure Key Vault REST API](https://learn.microsoft.com/en-us/rest/api/keyvault/)
- [OpenBao](https://openbao.org/) - Open source Vault fork (future consideration)
- [External Secrets Operator](https://external-secrets.io/) - K8s reference architecture

---

**Document Status:** Ready for review  
**Next Steps:**
1. Review by @rsdouglas and core maintainers
2. Community feedback period (2 weeks)
3. Finalize specification
4. Begin Phase 1 implementation

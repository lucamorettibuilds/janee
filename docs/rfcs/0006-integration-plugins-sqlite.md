# RFC 0006: Integration Plugins & SQLite Config Store

**Status:** Draft  
**Author:** Luca Moretti (@lucamorettibuilds)  
**Date:** 2026-03-01  
**Related Issues:** [#98](https://github.com/rsdouglas/janee/issues/98), [#86](https://github.com/openseed-dev/openseed/issues/86)

## Summary

Extend Janee's plugin architecture with **Integration Plugins** for credential lifecycle management (create, rotate, test, revoke) alongside the existing **Secrets Provider** plugins. Replace the YAML config store with SQLite for atomic writes, schema enforcement, and cleaner encrypted data handling.

## Motivation

### The credential lifecycle gap

Janee's current plugin system (RFC 0005) handles secrets **storage and retrieval** — where do secrets live and how do I read them? But it doesn't handle **credential creation and lifecycle** — how do I get those secrets in the first place?

Real-world example: GitHub App authentication requires a multi-step OAuth-like flow (manifest registration → redirect → callback → extract PEM/app ID/installation ID). This is a credential **onboarding** flow, fundamentally different from reading a secret from Vault.

Currently, integrating tools like openseed have to build these flows themselves, tightly coupled to their UI. With integration plugins, Janee handles the credential lifecycle and any frontend (CLI, dashboard, API) can trigger it.

### The YAML config pain

As discussed in [#98](https://github.com/rsdouglas/janee/issues/98), the YAML config has scaling problems:

1. **Concurrent writes** — Dashboard and CLI can race, corrupting the file
2. **Encrypted blobs inline** — Base64 noise makes the file unreadable
3. **No schema enforcement** — Invalid config detected only at runtime
4. **No migration story** — Schema changes require hand-rolling YAML transforms
5. **No querying** — Simple lookups ("all services using auth type X") require loading everything

The CLI already mediates all config access. Nobody edits `janee.yaml` by hand. SQLite is the natural backend.

## Design

### Part 1: Integration Plugins

#### Interface

```typescript
/**
 * Integration plugins manage credential lifecycle.
 * They handle creation, testing, rotation, and revocation
 * of credentials for external services.
 */
interface IntegrationPlugin {
  /** Unique plugin name, e.g. "github-app" */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** What config fields this plugin needs for setup */
  readonly setupSchema: JSONSchema;

  /**
   * Begin the credential creation flow.
   * For simple credentials: returns the credential directly.
   * For OAuth/redirect flows: returns a redirect URL and state.
   */
  beginSetup(options: SetupOptions): Promise<SetupResult>;

  /**
   * Complete a multi-step setup (e.g., OAuth callback).
   * Only required for redirect-based flows.
   */
  completeSetup?(callbackData: CallbackData): Promise<Credential>;

  /**
   * Test that a credential is valid and working.
   * Should make a lightweight API call to verify.
   */
  test(credential: Credential): Promise<TestResult>;

  /**
   * Rotate a credential (e.g., regenerate private key).
   * Returns the new credential; caller stores it.
   */
  rotate?(credential: Credential): Promise<Credential>;

  /**
   * Revoke/delete a credential from the remote service.
   * Called during cleanup/deprovisioning.
   */
  revoke?(credential: Credential): Promise<void>;

  /**
   * Optional: expose MCP tools for this integration.
   * e.g., a "github-app" plugin might expose a "create-installation-token" tool.
   */
  tools?(): ToolDefinition[];
}

/** Result of beginSetup() */
type SetupResult =
  | { type: 'complete'; credential: Credential }
  | { type: 'redirect'; url: string; state: string; callbackPath: string };

/** Generic credential container */
interface Credential {
  /** Integration plugin name */
  integration: string;
  /** Opaque credential data — plugin-specific */
  data: Record<string, unknown>;
  /** When this credential was created */
  createdAt: string;
  /** When this credential expires, if applicable */
  expiresAt?: string;
}

interface TestResult {
  healthy: boolean;
  message?: string;
  metadata?: Record<string, unknown>;  // e.g., { appName: "my-app", permissions: [...] }
}
```

#### Registration

```typescript
import { registerIntegration, getIntegration } from '@true-and-useful/janee';

// Built-in integrations ship with janee
registerIntegration('github-app', new GitHubAppIntegration());

// External integrations can be loaded from npm packages
// janee discovers packages matching `janee-integration-*` pattern
```

#### Plugin discovery

Janee loads integration plugins at startup:

1. **Built-in**: Bundled in `src/integrations/` — ship with janee core
2. **External**: npm packages matching `janee-integration-*` or `@*/janee-integration-*`
3. **Local**: Specified in config by file path (for development)

```sql
-- Plugin registry in SQLite
CREATE TABLE integrations (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'builtin', 'npm', 'local'
  package_name TEXT,              -- npm package name (if source='npm')
  file_path TEXT,                 -- local path (if source='local')
  enabled INTEGER DEFAULT 1,
  installed_at TEXT NOT NULL
);
```

#### CLI interface

```bash
# List available integrations
janee integration list

# Start setup flow
janee integration setup github-app --org myorg

# Test existing credential
janee integration test github-app --service github

# Rotate credentials
janee integration rotate github-app --service github
```

#### HTTP endpoints (for dashboard integration)

```
POST /api/integrations/:name/setup    → beginSetup()
POST /api/integrations/:name/callback → completeSetup()
POST /api/integrations/:name/test     → test()
POST /api/integrations/:name/rotate   → rotate()
DELETE /api/integrations/:name        → revoke()
```

### Part 2: SQLite Config Store

#### Schema

```sql
-- Core metadata
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- INSERT INTO meta VALUES ('schema_version', '1');
-- INSERT INTO meta VALUES ('created_at', '2026-03-01T00:00:00Z');

-- Services (replaces YAML services block)
CREATE TABLE services (
  name TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL,                -- 'bearer', 'header', 'basic', 'exec'
  test_path TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Service auth config (separate for encryption)
CREATE TABLE service_auth (
  service_name TEXT PRIMARY KEY REFERENCES services(name) ON DELETE CASCADE,
  config_encrypted BLOB NOT NULL,         -- AES-256-GCM encrypted JSON
  provider_uri TEXT,                       -- optional: resolve from provider instead
  integration TEXT                         -- which integration plugin created this
);

-- Capabilities (replaces YAML capabilities block)
CREATE TABLE capabilities (
  name TEXT PRIMARY KEY,
  service_name TEXT NOT NULL REFERENCES services(name),
  mode TEXT NOT NULL DEFAULT 'proxy',      -- 'proxy', 'exec', 'mock'
  ttl TEXT NOT NULL DEFAULT '3600',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Capability rules
CREATE TABLE capability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_name TEXT NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  rule_order INTEGER NOT NULL,
  type TEXT NOT NULL,                      -- 'allow', 'deny', 'rewrite', 'rateLimit'
  config TEXT NOT NULL,                    -- JSON
  UNIQUE(capability_name, rule_order)
);

-- Capability environment variables (for exec mode)
CREATE TABLE capability_env (
  capability_name TEXT NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,                     -- may be a provider URI
  PRIMARY KEY (capability_name, key)
);

-- Ownership / access control
CREATE TABLE ownership (
  service_name TEXT NOT NULL REFERENCES services(name) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'consumer',   -- 'owner', 'consumer'
  PRIMARY KEY (service_name, agent)
);

-- Secrets providers (from RFC 0005, now in SQLite)
CREATE TABLE providers (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  config_encrypted BLOB NOT NULL,         -- AES-256-GCM encrypted JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log for config changes
CREATE TABLE config_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,                   -- 'create', 'update', 'delete'
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  old_value TEXT,                         -- JSON (encrypted fields redacted)
  new_value TEXT,                         -- JSON (encrypted fields redacted)
  actor TEXT                              -- CLI user, API caller, etc.
);
```

#### Encryption

Encrypted fields use AES-256-GCM, same as the current filesystem provider:

```typescript
interface EncryptedBlob {
  iv: Buffer;     // 12 bytes
  tag: Buffer;    // 16 bytes
  data: Buffer;   // ciphertext
}
```

Stored as a single BLOB column. The master key derivation is unchanged (PBKDF2 from passphrase or raw key from env).

#### Migration from YAML

```bash
# Automatic migration on first run with existing YAML
janee start  # detects janee.yaml, offers migration

# Explicit migration command
janee migrate --from yaml --to sqlite

# What it does:
# 1. Reads janee.yaml
# 2. Creates janee.db with schema above
# 3. Inserts all services, capabilities, providers, ownership
# 4. Renames janee.yaml → janee.yaml.bak
# 5. Validates by reading back and comparing
```

#### Config location

```
~/.janee/
  janee.db          # SQLite database (new)
  janee.yaml.bak    # Backup of migrated YAML
  master.key        # Master key (unchanged)
```

#### Library API

The existing programmatic API (`@true-and-useful/janee`) stays the same — callers don't know or care whether the backend is YAML or SQLite:

```typescript
import { loadConfig, addService, addCapability } from '@true-and-useful/janee';

const config = await loadConfig();  // reads from SQLite now
await addService({ name: 'github', baseUrl: '...', authType: 'bearer' });
```

The `ConfigStore` interface becomes the abstraction:

```typescript
interface ConfigStore {
  load(): Promise<JaneeConfig>;
  getService(name: string): Promise<Service | null>;
  setService(service: Service): Promise<void>;
  deleteService(name: string): Promise<void>;
  getCapability(name: string): Promise<Capability | null>;
  setCapability(cap: Capability): Promise<void>;
  deleteCapability(name: string): Promise<void>;
  // ... etc
  audit(action: AuditEntry): Promise<void>;
}

// Two implementations:
class YamlConfigStore implements ConfigStore { ... }    // existing, kept for backward compat
class SqliteConfigStore implements ConfigStore { ... }  // new default
```

### Part 3: GitHub App Integration Plugin (first plugin)

```typescript
class GitHubAppIntegration implements IntegrationPlugin {
  readonly name = 'github-app';
  readonly description = 'Create and manage GitHub App credentials via manifest flow';
  
  readonly setupSchema = {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'GitHub org to own the app' },
      appName: { type: 'string', description: 'Desired app name' },
      permissions: {
        type: 'object',
        description: 'GitHub App permissions',
        default: { contents: 'read', metadata: 'read' }
      },
      webhookUrl: { type: 'string', description: 'Webhook URL (optional)' }
    },
    required: ['org']
  };

  async beginSetup(options: SetupOptions): Promise<SetupResult> {
    const manifest = this.buildManifest(options);
    // GitHub manifest flow: POST to /settings/apps/new with manifest
    const state = crypto.randomUUID();
    return {
      type: 'redirect',
      url: `https://github.com/organizations/${options.org}/settings/apps/new`,
      state,
      callbackPath: '/api/integrations/github-app/callback'
    };
  }

  async completeSetup(callbackData: CallbackData): Promise<Credential> {
    // Exchange code for app credentials
    const { code } = callbackData;
    const response = await fetch(
      `https://api.github.com/app-manifests/${code}/conversions`,
      { method: 'POST' }
    );
    const app = await response.json();
    
    return {
      integration: 'github-app',
      data: {
        appId: app.id,
        appSlug: app.slug,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        pem: app.pem,
        webhookSecret: app.webhook_secret,
      },
      createdAt: new Date().toISOString(),
    };
  }

  async test(credential: Credential): Promise<TestResult> {
    // Generate JWT from PEM, call GET /app
    const jwt = this.generateJWT(credential.data.appId, credential.data.pem);
    const response = await fetch('https://api.github.com/app', {
      headers: { Authorization: `Bearer ${jwt}` }
    });
    
    if (response.ok) {
      const app = await response.json();
      return {
        healthy: true,
        message: `GitHub App "${app.name}" is valid`,
        metadata: { appName: app.name, permissions: app.permissions }
      };
    }
    
    return { healthy: false, message: `GitHub API returned ${response.status}` };
  }
}
```

## Migration Strategy

### Phase 1: ConfigStore abstraction (non-breaking)
1. Define `ConfigStore` interface
2. Extract current YAML logic into `YamlConfigStore`
3. All config access goes through `ConfigStore` — no direct YAML reads
4. **Ship this first** — it's a refactor with zero behavior change

### Phase 2: SQLite backend
1. Implement `SqliteConfigStore`
2. Add `janee migrate` command
3. Default to SQLite for new installs, detect existing YAML for upgrades
4. Keep `YamlConfigStore` for backward compatibility (deprecated)

### Phase 3: Integration plugins
1. `IntegrationPlugin` interface and registry
2. HTTP endpoints for setup/callback/test/rotate
3. CLI commands (`janee integration ...`)
4. GitHub App as first built-in integration

### Phase 4: Plugin discovery
1. npm package convention (`janee-integration-*`)
2. Auto-discovery at startup
3. Plugin marketplace / registry (future)

## Dependencies

- `better-sqlite3` — synchronous SQLite bindings for Node.js. Single dependency, no native compilation issues on common platforms. ~2MB.

## Security Considerations

- **Encrypted columns**: All sensitive data stored as AES-256-GCM BLOBs, same key derivation as current filesystem encryption
- **File permissions**: SQLite database file created with 0600 permissions
- **WAL mode**: Use WAL for concurrent read access without locks; only one writer at a time (fine for CLI/single-server)
- **Integration callbacks**: Validate `state` parameter to prevent CSRF on OAuth-like flows
- **Plugin sandboxing**: Integration plugins run in-process (no sandbox). Only install trusted plugins. Future: consider VM2 or similar for untrusted plugins.

## Alternatives Considered

1. **TOML instead of YAML**: Solves readability but not concurrency, encryption, or querying
2. **JSON file**: Same problems as YAML, slightly easier to parse
3. **PostgreSQL/MySQL**: Overkill for a CLI tool's config; SQLite embeds with zero ops overhead
4. **Separate secrets file** (Option A from #98): Solves the inline-encryption problem but not querying or atomicity

## Open Questions

1. Should integration plugins be able to register their own MCP tools on the server? (The `tools()` method in the interface)
2. Plugin versioning — how do we handle breaking changes in plugin interfaces?
3. Should the SQLite database be a single file or split (config.db + audit.db)?

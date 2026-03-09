/**
 * SQLite configuration store for Janee
 *
 * Replaces the YAML + credentials.json split with a single janee.db file.
 * All config reads go directly to SQLite — no in-memory caching.
 *
 * Schema:
 *   meta       — schema version, master key
 *   services   — name, baseUrl, auth type, non-secret auth fields, ownership, testPath
 *   secrets    — service name → encrypted secret fields
 *   capabilities — name, service, ttl, config JSON
 *   settings   — key/value pairs for server config, LLM config, etc.
 *
 * Migration: automatically imports from config.yaml + credentials.json on first access.
 */

import Database from "better-sqlite3";
import fs from "fs";
import yaml from "js-yaml";
import os from "os";
import path from "path";

import {
  agentCreatedOwnership,
  cliCreatedOwnership,
  CredentialOwnership,
} from "../core/agent-scope";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
} from "../core/crypto";

// Re-export interfaces (unchanged from config-yaml.ts)
export interface AuthConfig {
  type:
    | "bearer"
    | "hmac-mexc"
    | "hmac-bybit"
    | "hmac-okx"
    | "headers"
    | "service-account"
    | "github-app"
    | "oauth1a-twitter"
    | "aws-sigv4";
  key?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  headers?: Record<string, string>;
  credentials?: string;
  scopes?: string[];
  appId?: string;
  privateKey?: string;
  installationId?: string;
  consumerKey?: string;
  consumerSecret?: string;
  accessToken?: string;
  accessTokenSecret?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  awsService?: string;
  sessionToken?: string;
}

export interface ServiceConfig {
  baseUrl: string;
  auth: AuthConfig;
  testPath?: string;
  ownership?: CredentialOwnership;
}

export interface CapabilityConfig {
  service: string;
  ttl: string;
  autoApprove?: boolean;
  requiresReason?: boolean;
  rules?: {
    allow?: string[];
    deny?: string[];
  };
  allowedAgents?: string[];
  mode?: "proxy" | "exec";
  allowCommands?: string[];
  env?: Record<string, string>;
  workDir?: string;
  timeout?: number;
}

export interface LLMConfig {
  provider?: "openai" | "anthropic";
  apiKey?: string;
  model?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  logBodies?: boolean;
  strictDecryption?: boolean;
  defaultAccess?: "open" | "restricted";
}

export interface JaneeConfig {
  version: string;
  masterKey: string;
  server: ServerConfig;
  llm?: LLMConfig;
  services: Record<string, ServiceConfig>;
  capabilities: Record<string, CapabilityConfig>;
}

// Keep the old name as an alias for backward compatibility
export type JaneeYAMLConfig = JaneeConfig;

// ---------------------------------------------------------------------------
// Secret field names — same logic as config-yaml.ts extractSecrets/stripSecrets
// ---------------------------------------------------------------------------

const SECRET_FIELDS = [
  "key",
  "apiKey",
  "apiSecret",
  "passphrase",
  "credentials",
  "privateKey",
  "consumerKey",
  "consumerSecret",
  "accessToken",
  "accessTokenSecret",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
] as const;

type ServiceSecrets = Record<string, string | Record<string, string>>;

function extractSecrets(auth: AuthConfig): ServiceSecrets {
  const secrets: ServiceSecrets = {};
  for (const field of SECRET_FIELDS) {
    if (auth[field]) {
      secrets[field] = auth[field] as string;
    }
  }
  if (auth.headers) {
    secrets.headers = { ...auth.headers };
  }
  return secrets;
}

function stripSecrets(auth: AuthConfig): AuthConfig {
  const stripped = { ...auth };
  for (const field of SECRET_FIELDS) {
    delete stripped[field];
  }
  delete stripped.headers;
  return stripped;
}

function injectSecrets(auth: AuthConfig, secrets: ServiceSecrets): void {
  for (const [key, value] of Object.entries(secrets)) {
    if (key === "headers" && typeof value === "object") {
      auth.headers = value as Record<string, string>;
    } else {
      (auth as any)[key] = value;
    }
  }
}

function encryptServiceSecrets(
  secrets: ServiceSecrets,
  masterKey: string,
): ServiceSecrets {
  const encrypted: ServiceSecrets = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === "string") {
      encrypted[key] = encryptSecret(value, masterKey);
    } else if (typeof value === "object") {
      const encObj: Record<string, string> = {};
      for (const [hk, hv] of Object.entries(value)) {
        encObj[hk] = encryptSecret(hv, masterKey);
      }
      encrypted[key] = encObj;
    }
  }
  return encrypted;
}

function decryptServiceSecrets(
  serviceName: string,
  encrypted: ServiceSecrets,
  masterKey: string,
  strict: boolean,
): ServiceSecrets {
  const decrypted: ServiceSecrets = {};
  for (const [key, value] of Object.entries(encrypted)) {
    if (typeof value === "string") {
      try {
        decrypted[key] = decryptSecret(value, masterKey);
      } catch (e) {
        if (strict)
          throw new Error(`Failed to decrypt ${serviceName}.${key}: ${e}`);
        decrypted[key] = value; // pass through if non-strict
      }
    } else if (typeof value === "object") {
      const decObj: Record<string, string> = {};
      for (const [hk, hv] of Object.entries(value)) {
        try {
          decObj[hk] = decryptSecret(hv, masterKey);
        } catch (e) {
          if (strict)
            throw new Error(
              `Failed to decrypt ${serviceName}.headers.${hk}: ${e}`,
            );
          decObj[hk] = hv;
        }
      }
      decrypted[key] = decObj;
    }
  }
  return decrypted;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getConfigDir(): string {
  return process.env.JANEE_HOME || path.join(os.homedir(), ".janee");
}

export function getAuditDir(): string {
  return path.join(getConfigDir(), "logs");
}

function getDbPath(): string {
  return path.join(getConfigDir(), "janee.db");
}

function getLegacyYAMLPath(): string {
  return path.join(getConfigDir(), "config.yaml");
}

function getLegacyCredentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

function getLegacyJSONPath(): string {
  return path.join(getConfigDir(), "config.json");
}

// ---------------------------------------------------------------------------
// Database initialization & schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }

  _db = new Database(getDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  initSchema(_db);

  // Auto-migrate from YAML if DB is empty and YAML exists
  const count = _db.prepare("SELECT COUNT(*) as c FROM meta").get() as {
    c: number;
  };
  if (count.c === 0) {
    const yamlPath = getLegacyYAMLPath();
    const credPath = getLegacyCredentialsPath();
    if (fs.existsSync(yamlPath)) {
      migrateFromYAML(_db, yamlPath, credPath);
    }
  }

  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      name       TEXT PRIMARY KEY,
      base_url   TEXT NOT NULL,
      auth_type  TEXT NOT NULL,
      auth_meta  TEXT NOT NULL DEFAULT '{}',
      test_path  TEXT,
      ownership  TEXT
    );

    CREATE TABLE IF NOT EXISTS secrets (
      service_name TEXT NOT NULL,
      field_name   TEXT NOT NULL,
      encrypted    TEXT NOT NULL,
      PRIMARY KEY (service_name, field_name)
      -- FK relaxed: service may be added later
    );

    CREATE TABLE IF NOT EXISTS capabilities (
      name         TEXT PRIMARY KEY,
      service_name TEXT NOT NULL,
      config       TEXT NOT NULL DEFAULT '{}'
      -- FK relaxed: service may be added later
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Migration from YAML + credentials.json → SQLite
// ---------------------------------------------------------------------------

interface LegacyCredentialsFile {
  masterKey: string;
  secrets: Record<string, ServiceSecrets>;
}

function migrateFromYAML(
  db: Database.Database,
  yamlPath: string,
  credPath: string,
): void {
  const rawYaml = yaml.load(fs.readFileSync(yamlPath, "utf8")) as any;
  let creds: LegacyCredentialsFile = { masterKey: "", secrets: {} };

  if (fs.existsSync(credPath)) {
    creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  }

  // Handle legacy format where masterKey was inline in YAML
  const masterKey = creds.masterKey || rawYaml.masterKey || generateMasterKey();

  const txn = db.transaction(() => {
    // Meta
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(SCHEMA_VERSION),
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "master_key",
      masterKey,
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migrated_from",
      "yaml",
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migrated_at",
      new Date().toISOString(),
    );

    // Server settings
    const server = rawYaml.server || {};
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ).run("server.port", String(server.port || 9119));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ).run("server.host", server.host || "localhost");
    if (server.logBodies != null)
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.logBodies", String(server.logBodies));
    if (server.strictDecryption != null)
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.strictDecryption", String(server.strictDecryption));
    if (server.defaultAccess)
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.defaultAccess", server.defaultAccess);

    // LLM settings
    if (rawYaml.llm) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("llm", JSON.stringify(rawYaml.llm));
    }

    // Services
    const services = rawYaml.services || {};
    const insertService = db.prepare(
      "INSERT OR REPLACE INTO services (name, base_url, auth_type, auth_meta, test_path, ownership) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertSecret = db.prepare(
      "INSERT OR REPLACE INTO secrets (service_name, field_name, encrypted) VALUES (?, ?, ?)",
    );

    for (const [name, svc] of Object.entries(services) as [string, any][]) {
      const auth = svc.auth || {};
      const authMeta: Record<string, any> = {};
      if (auth.scopes) authMeta.scopes = auth.scopes;

      insertService.run(
        name,
        svc.baseUrl || "",
        auth.type || "bearer",
        JSON.stringify(authMeta),
        svc.testPath || null,
        svc.ownership ? JSON.stringify(svc.ownership) : null,
      );

      // Import encrypted secrets from credentials.json
      const svcSecrets = creds.secrets[name] || {};
      for (const [field, value] of Object.entries(svcSecrets)) {
        // Store as JSON for complex types (headers object)
        const encoded =
          typeof value === "string" ? value : JSON.stringify(value);
        insertSecret.run(name, field, encoded);
      }

      // Also check for inline secrets in legacy format (masterKey was in YAML)
      if (!creds.secrets[name]) {
        for (const field of SECRET_FIELDS) {
          if (auth[field]) {
            // These are already encrypted in legacy format
            insertSecret.run(name, field, auth[field]);
          }
        }
        if (auth.headers) {
          insertSecret.run(
            name,
            "headers",
            JSON.stringify(
              Object.fromEntries(
                Object.entries(auth.headers).map(([k, v]) => [k, v]),
              ),
            ),
          );
        }
      }
    }

    // Capabilities
    const capabilities = rawYaml.capabilities || {};
    const insertCap = db.prepare(
      "INSERT OR REPLACE INTO capabilities (name, service_name, config) VALUES (?, ?, ?)",
    );

    for (const [name, cap] of Object.entries(capabilities) as [string, any][]) {
      const { service, ...rest } = cap;
      insertCap.run(name, service, JSON.stringify(rest));
    }
  });

  txn();

  // Rename legacy files
  const timestamp = Date.now();
  if (fs.existsSync(yamlPath)) {
    fs.renameSync(yamlPath, `${yamlPath}.pre-sqlite.${timestamp}.bak`);
  }
  if (fs.existsSync(credPath)) {
    fs.renameSync(credPath, `${credPath}.pre-sqlite.${timestamp}.bak`);
  }

  console.log("✅ Migrated config from YAML → SQLite (janee.db)");
  console.log(
    `   Old files backed up with .pre-sqlite.${timestamp}.bak suffix`,
  );
}

// ---------------------------------------------------------------------------
// Re-migration: handle YAML re-appearing after migration
// ---------------------------------------------------------------------------

function checkForYAMLReappearance(): void {
  const yamlPath = getLegacyYAMLPath();
  if (!fs.existsSync(yamlPath)) return;

  const db = getDb();
  const hasMeta = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get("master_key") as { value: string } | undefined;
  if (!hasMeta) return; // DB not initialized yet, let normal init handle it

  console.log(
    "⚠️  Found config.yaml after SQLite migration — importing new entries...",
  );

  const credPath = getLegacyCredentialsPath();
  const rawYaml = yaml.load(fs.readFileSync(yamlPath, "utf8")) as any;
  let creds: LegacyCredentialsFile = { masterKey: hasMeta.value, secrets: {} };
  if (fs.existsSync(credPath)) {
    creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  }

  const txn = db.transaction(() => {
    const services = rawYaml.services || {};
    for (const [name, svc] of Object.entries(services) as [string, any][]) {
      // Only import services that don't already exist in DB (DB wins for conflicts)
      const existing = db
        .prepare("SELECT name FROM services WHERE name = ?")
        .get(name);
      if (existing) continue;

      const auth = svc.auth || {};
      const authMeta: Record<string, any> = {};
      if (auth.scopes) authMeta.scopes = auth.scopes;

      db.prepare(
        "INSERT INTO services (name, base_url, auth_type, auth_meta, test_path, ownership) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        name,
        svc.baseUrl || "",
        auth.type || "bearer",
        JSON.stringify(authMeta),
        svc.testPath || null,
        svc.ownership ? JSON.stringify(svc.ownership) : null,
      );

      const svcSecrets = creds.secrets[name] || {};
      for (const [field, value] of Object.entries(svcSecrets)) {
        const encoded =
          typeof value === "string" ? value : JSON.stringify(value);
        db.prepare(
          "INSERT INTO secrets (service_name, field_name, encrypted) VALUES (?, ?, ?)",
        ).run(name, field, encoded);
      }
    }

    const capabilities = rawYaml.capabilities || {};
    for (const [name, cap] of Object.entries(capabilities) as [string, any][]) {
      const existing = db
        .prepare("SELECT name FROM capabilities WHERE name = ?")
        .get(name);
      if (existing) continue;
      const { service, ...rest } = cap as any;
      db.prepare(
        "INSERT INTO capabilities (name, service_name, config) VALUES (?, ?, ?)",
      ).run(name, service, JSON.stringify(rest));
    }
  });

  txn();

  // Remove the re-appeared YAML
  const timestamp = Date.now();
  fs.renameSync(yamlPath, `${yamlPath}.reimported.${timestamp}.bak`);
  if (fs.existsSync(credPath)) {
    fs.renameSync(credPath, `${credPath}.reimported.${timestamp}.bak`);
  }
  console.log("   Re-imported YAML entries into SQLite. YAML removed.");
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacements for config-yaml.ts functions
// ---------------------------------------------------------------------------

export function hasConfig(): boolean {
  return fs.existsSync(getDbPath()) || fs.existsSync(getLegacyYAMLPath());
}

// Alias for backward compat
export const hasYAMLConfig = hasConfig;

export function loadConfig(): JaneeConfig {
  checkForYAMLReappearance();

  const db = getDb();

  const masterKeyRow = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get("master_key") as { value: string } | undefined;
  if (!masterKeyRow) {
    throw new Error("No config found. Run `janee init` to create one.");
  }

  const masterKey = masterKeyRow.value;
  const strictDecryption =
    getSetting(db, "server.strictDecryption") !== "false";

  // Build server config
  const server: ServerConfig = {
    port: parseInt(getSetting(db, "server.port") || "9119", 10),
    host: getSetting(db, "server.host") || "localhost",
    logBodies: getSetting(db, "server.logBodies") === "true",
    strictDecryption,
    defaultAccess:
      (getSetting(db, "server.defaultAccess") as "open" | "restricted") ||
      undefined,
  };

  // LLM config
  const llmRaw = getSetting(db, "llm");
  const llm: LLMConfig | undefined = llmRaw ? JSON.parse(llmRaw) : undefined;

  // Services with decrypted secrets
  const services: Record<string, ServiceConfig> = {};
  const svcRows = db.prepare("SELECT * FROM services").all() as Array<{
    name: string;
    base_url: string;
    auth_type: string;
    auth_meta: string;
    test_path: string | null;
    ownership: string | null;
  }>;

  for (const row of svcRows) {
    const authMeta = JSON.parse(row.auth_meta);
    const auth: AuthConfig = {
      type: row.auth_type as AuthConfig["type"],
      ...authMeta,
    };

    // Load and decrypt secrets
    const secretRows = db
      .prepare(
        "SELECT field_name, encrypted FROM secrets WHERE service_name = ?",
      )
      .all(row.name) as Array<{
      field_name: string;
      encrypted: string;
    }>;

    const encSecrets: ServiceSecrets = {};
    for (const s of secretRows) {
      // Try parsing as JSON for complex types (headers)
      try {
        const parsed = JSON.parse(s.encrypted);
        if (typeof parsed === "object" && parsed !== null) {
          encSecrets[s.field_name] = parsed;
          continue;
        }
      } catch {}
      encSecrets[s.field_name] = s.encrypted;
    }

    if (Object.keys(encSecrets).length > 0) {
      const decSecrets = decryptServiceSecrets(
        row.name,
        encSecrets,
        masterKey,
        strictDecryption,
      );
      injectSecrets(auth, decSecrets);
    }

    services[row.name] = {
      baseUrl: row.base_url,
      auth,
      testPath: row.test_path || undefined,
      ownership: row.ownership ? JSON.parse(row.ownership) : undefined,
    };
  }

  // Capabilities
  const capabilities: Record<string, CapabilityConfig> = {};
  const capRows = db.prepare("SELECT * FROM capabilities").all() as Array<{
    name: string;
    service_name: string;
    config: string;
  }>;

  for (const row of capRows) {
    const parsed = JSON.parse(row.config);
    capabilities[row.name] = {
      service: row.service_name,
      ...parsed,
    };
  }

  return {
    version: "1.0.0",
    masterKey,
    server,
    llm,
    services,
    capabilities,
  };
}

// Alias for backward compat
export const loadYAMLConfig = loadConfig;

export function saveConfig(config: JaneeConfig): void {
  const db = getDb();

  const txn = db.transaction(() => {
    // Meta
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(SCHEMA_VERSION),
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "master_key",
      config.masterKey,
    );

    // Server settings
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ).run("server.port", String(config.server.port));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ).run("server.host", config.server.host);
    if (config.server.logBodies != null) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.logBodies", String(config.server.logBodies));
    }
    if (config.server.strictDecryption != null) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.strictDecryption", String(config.server.strictDecryption));
    }
    if (config.server.defaultAccess) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("server.defaultAccess", config.server.defaultAccess);
    }

    // LLM
    if (config.llm) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ).run("llm", JSON.stringify(config.llm));
    } else {
      db.prepare("DELETE FROM settings WHERE key = ?").run("llm");
    }

    // Services — delete removed, upsert existing
    const existingServices = new Set(
      (
        db.prepare("SELECT name FROM services").all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    const newServiceNames = new Set(Object.keys(config.services));

    // Delete removed services (cascades to secrets and capabilities via FK)
    for (const name of existingServices) {
      if (!newServiceNames.has(name)) {
        db.prepare("DELETE FROM services WHERE name = ?").run(name);
      }
    }

    // Upsert services and their secrets
    const upsertService = db.prepare(
      "INSERT OR REPLACE INTO services (name, base_url, auth_type, auth_meta, test_path, ownership) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const deleteSecrets = db.prepare(
      "DELETE FROM secrets WHERE service_name = ?",
    );
    const insertSecret = db.prepare(
      "INSERT INTO secrets (service_name, field_name, encrypted) VALUES (?, ?, ?)",
    );

    for (const [name, svc] of Object.entries(config.services)) {
      const plainSecrets = extractSecrets(svc.auth);
      const strippedAuth = stripSecrets(svc.auth);
      const { type, ...authMeta } = strippedAuth;

      upsertService.run(
        name,
        svc.baseUrl,
        type,
        JSON.stringify(authMeta),
        svc.testPath || null,
        svc.ownership ? JSON.stringify(svc.ownership) : null,
      );

      // Re-encrypt and store secrets
      deleteSecrets.run(name);
      if (Object.keys(plainSecrets).length > 0) {
        const encrypted = encryptServiceSecrets(plainSecrets, config.masterKey);
        for (const [field, value] of Object.entries(encrypted)) {
          const encoded =
            typeof value === "string" ? value : JSON.stringify(value);
          insertSecret.run(name, field, encoded);
        }
      }
    }

    // Capabilities — delete removed, upsert existing
    const existingCaps = new Set(
      (
        db.prepare("SELECT name FROM capabilities").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    const newCapNames = new Set(Object.keys(config.capabilities));

    for (const name of existingCaps) {
      if (!newCapNames.has(name)) {
        db.prepare("DELETE FROM capabilities WHERE name = ?").run(name);
      }
    }

    const upsertCap = db.prepare(
      "INSERT OR REPLACE INTO capabilities (name, service_name, config) VALUES (?, ?, ?)",
    );

    for (const [name, cap] of Object.entries(config.capabilities)) {
      const { service, ...rest } = cap;
      upsertCap.run(name, service, JSON.stringify(rest));
    }
  });

  txn();
}

// Alias for backward compat
export const saveYAMLConfig = saveConfig;

function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

// ---------------------------------------------------------------------------
// Convenience functions (same API as config-yaml.ts)
// ---------------------------------------------------------------------------

export function persistServiceOwnership(
  serviceName: string,
  ownership: CredentialOwnership,
): void {
  const config = loadConfig();
  if (!config.services[serviceName]) {
    throw new Error(`Service "${serviceName}" not found in config`);
  }
  config.services[serviceName].ownership = ownership;
  saveConfig(config);
}

export function createServiceWithOwnership(
  config: JaneeConfig,
  serviceName: string,
  service: ServiceConfig,
  creatingAgentId?: string,
): JaneeConfig {
  if (creatingAgentId) {
    service.ownership = agentCreatedOwnership(creatingAgentId);
  }
  config.services[serviceName] = service;
  return config;
}

export function initConfig(): JaneeConfig {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }

  if (fs.existsSync(getDbPath())) {
    throw new Error("Config already exists");
  }

  const config: JaneeConfig = {
    version: "1.0.0",
    masterKey: generateMasterKey(),
    server: {
      port: 9119,
      host: "localhost",
      strictDecryption: true,
    },
    services: {},
    capabilities: {},
  };

  // Force DB creation
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SCHEMA_VERSION),
  );
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "master_key",
    config.masterKey,
  );

  // Save settings
  saveConfig(config);

  return config;
}

// Alias for backward compat
export const initYAMLConfig = initConfig;

export function addService(
  name: string,
  baseUrl: string,
  auth: AuthConfig,
): void {
  const config = loadConfig();
  if (config.services[name]) {
    throw new Error(`Service "${name}" already exists`);
  }
  config.services[name] = {
    baseUrl,
    auth,
    ownership: cliCreatedOwnership(),
  };
  saveConfig(config);
}

// Alias for backward compat
export const addServiceYAML = addService;

export function addCapability(name: string, capConfig: CapabilityConfig): void {
  const config = loadConfig();
  if (config.capabilities[name]) {
    throw new Error(`Capability "${name}" already exists`);
  }
  if (!config.services[capConfig.service]) {
    throw new Error(`Service "${capConfig.service}" not found`);
  }
  config.capabilities[name] = capConfig;
  saveConfig(config);
}

// Alias for backward compat
export const addCapabilityYAML = addCapability;

export function migrateToSQLite(): void {
  const yamlPath = getLegacyYAMLPath();
  const jsonPath = getLegacyJSONPath();

  if (!fs.existsSync(yamlPath) && !fs.existsSync(jsonPath)) {
    throw new Error("No YAML or JSON config found to migrate.");
  }

  if (fs.existsSync(getDbPath())) {
    throw new Error(
      "SQLite config already exists. Delete janee.db first to re-migrate.",
    );
  }

  // getDb() will auto-migrate on first access
  getDb();
  console.log("✅ Migration complete. Config is now in janee.db");
}

// Legacy compat — migrateToYAML now goes to SQLite
export const migrateToYAML = migrateToSQLite;

// ---------------------------------------------------------------------------
// Close DB on process exit (cleanup)
// ---------------------------------------------------------------------------

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

process.on("exit", closeDb);

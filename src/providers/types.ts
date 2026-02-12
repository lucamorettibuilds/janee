/**
 * Secrets Provider Plugin Interface
 * 
 * Defines the contract all secrets providers must implement.
 * See RFC 0005 for full design: docs/rfcs/0005-plugin-architecture.md
 */

/**
 * Core interface that all secrets providers must implement.
 */
export interface SecretsProvider {
  /** Human-readable provider name (e.g., "my-vault") */
  readonly name: string;
  
  /** Provider type identifier (e.g., "hashicorp-vault", "aws-secrets-manager") */
  readonly type: string;

  /**
   * Initialize the provider (connect, authenticate, validate config).
   * Called once before any secret operations.
   * @throws if provider cannot be initialized
   */
  initialize(): Promise<void>;

  /**
   * Retrieve a secret by path.
   * @param path - Provider-specific path (e.g., "mcp/agents/stripe/api-key")
   * @returns The secret value, or null if not found
   * @throws on connection/auth errors (NOT on missing secrets)
   */
  getSecret(path: string): Promise<string | null>;

  /**
   * Store a secret. Optional — not all providers support writes.
   * @param path - Provider-specific path
   * @param value - Secret value to store
   */
  setSecret?(path: string, value: string): Promise<void>;

  /**
   * Delete a secret. Optional.
   */
  deleteSecret?(path: string): Promise<void>;

  /**
   * List available secret paths. Optional — useful for CLI tooling.
   */
  listSecrets?(prefix?: string): Promise<string[]>;

  /**
   * Clean up resources (close connections, etc.).
   */
  dispose(): Promise<void>;

  /**
   * Health check — is the provider accessible and authenticated?
   */
  healthCheck(): Promise<HealthCheckResult>;
}

export interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  /** Optional latency in milliseconds */
  latencyMs?: number;
}

/**
 * Configuration for a provider instance.
 * The `config` field is provider-type-specific.
 */
export interface ProviderConfig {
  /** Instance name (referenced in service configs) */
  name: string;
  /** Provider type (determines which class to instantiate) */
  type: string;
  /** Type-specific configuration */
  config: Record<string, unknown>;
}

/**
 * Factory function type for creating provider instances.
 */
export type ProviderFactory = (config: ProviderConfig) => SecretsProvider;

/**
 * Parse a provider URI like "vault://mcp/stripe/api-key"
 * Returns { provider: "vault", path: "mcp/stripe/api-key" }
 * If no scheme, returns { provider: null, path: original }
 */
export function parseProviderURI(uri: string): { provider: string | null; path: string } {
  const match = uri.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\/\/(.+)$/);
  if (match) {
    return { provider: match[1], path: match[2] };
  }
  return { provider: null, path: uri };
}

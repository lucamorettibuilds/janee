/**
 * Provider Registry
 * 
 * Central registry for secrets provider factories.
 * Resolves provider URIs and manages provider lifecycle.
 */

import { SecretsProvider, ProviderConfig, ProviderFactory, parseProviderURI } from './types';
import { FilesystemProvider } from './filesystem';
import { EnvProvider } from './env';

/**
 * Registry of provider factories by type name.
 */
const factories = new Map<string, ProviderFactory>();

/**
 * Active provider instances by name.
 */
const instances = new Map<string, SecretsProvider>();

/**
 * Register a built-in provider factory.
 */
export function registerProviderType(type: string, factory: ProviderFactory): void {
  if (factories.has(type)) {
    throw new Error(`Provider type "${type}" is already registered`);
  }
  factories.set(type, factory);
}

/**
 * Create and register a provider instance from config.
 */
export async function createProvider(config: ProviderConfig): Promise<SecretsProvider> {
  const factory = factories.get(config.type);
  if (!factory) {
    const available = Array.from(factories.keys()).join(', ');
    throw new Error(
      `Unknown provider type "${config.type}". Available types: ${available}`
    );
  }

  const provider = factory(config);
  await provider.initialize();
  instances.set(config.name, provider);
  return provider;
}

/**
 * Get a registered provider instance by name.
 */
export function getProvider(name: string): SecretsProvider | undefined {
  return instances.get(name);
}

/**
 * Resolve a secret value from a URI like "vault://path/to/secret"
 * or a plain path (uses the default provider).
 * 
 * @param uri - Provider URI or plain secret path
 * @param defaultProvider - Provider name to use when no scheme is specified
 */
export async function resolveSecret(
  uri: string, 
  defaultProvider: string = 'local'
): Promise<string | null> {
  const { provider: providerName, path } = parseProviderURI(uri);
  const name = providerName || defaultProvider;
  
  const provider = instances.get(name);
  if (!provider) {
    const available = Array.from(instances.keys()).join(', ');
    throw new Error(
      `Provider "${name}" not found. Available providers: ${available}`
    );
  }
  
  return provider.getSecret(path);
}

/**
 * Health check all registered providers.
 */
export async function healthCheckAll(): Promise<Record<string, { healthy: boolean; error?: string }>> {
  const results: Record<string, { healthy: boolean; error?: string }> = {};
  
  for (const [name, provider] of instances) {
    results[name] = await provider.healthCheck();
  }
  
  return results;
}

/**
 * Dispose all providers (cleanup on shutdown).
 */
export async function disposeAll(): Promise<void> {
  const errors: Error[] = [];
  
  for (const [name, provider] of instances) {
    try {
      await provider.dispose();
    } catch (err) {
      errors.push(new Error(`Failed to dispose provider "${name}": ${(err as Error).message}`));
    }
  }
  
  instances.clear();
  
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Some providers failed to dispose');
  }
}

// Register built-in providers
registerProviderType('filesystem', (config) => new FilesystemProvider(config));
registerProviderType('env', (config) => new EnvProvider(config));

export { parseProviderURI } from './types';
export type { SecretsProvider, ProviderConfig, ProviderFactory, HealthCheckResult } from './types';

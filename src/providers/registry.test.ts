/**
 * Tests for the Provider Registry
 *
 * Covers provider type registration, instance lifecycle,
 * URI-based secret resolution, health checks, and disposal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createProvider,
  getProvider,
  resolveSecret,
  healthCheckAll,
  disposeAll,
  registerProviderType,
} from './registry';
import {
  SecretError,
  SecretErrorCode,
  SecretsProvider,
  ProviderConfig,
} from './types';

/**
 * Minimal in-memory provider for registry tests.
 * Avoids filesystem/crypto dependencies so tests are fast and isolated.
 */
function createMockProvider(config: ProviderConfig): SecretsProvider {
  const secrets = new Map<string, string>();
  let initialized = false;
  let disposed = false;

  return {
    name: config.name,
    type: config.type,
    async initialize() {
      initialized = true;
    },
    async getSecret(path: string) {
      if (!initialized || disposed) return null;
      return secrets.get(path) ?? null;
    },
    async setSecret(path: string, value: string) {
      secrets.set(path, value);
    },
    async deleteSecret(path: string) {
      secrets.delete(path);
    },
    async listSecrets() {
      return Array.from(secrets.keys());
    },
    async healthCheck() {
      return { healthy: !disposed, latencyMs: 1 };
    },
    async dispose() {
      disposed = true;
    },
  };
}

/**
 * A provider factory that always throws during initialize().
 */
function createBrokenProvider(config: ProviderConfig): SecretsProvider {
  return {
    name: config.name,
    type: config.type,
    async initialize() {
      throw new Error('connection refused');
    },
    async getSecret() {
      return null;
    },
    async healthCheck() {
      return { healthy: false, error: 'not initialized' };
    },
    async dispose() {},
  };
}

describe('Provider Registry', () => {
  afterEach(async () => {
    // Clean up all instances and factories after each test.
    // disposeAll clears both maps, then we re-register built-ins
    // so subsequent tests (and the module state) stay consistent.
    try {
      await disposeAll();
    } catch {
      // Ignore disposal errors in cleanup
    }
  });

  describe('registerProviderType', () => {
    it('registers a custom provider type', () => {
      registerProviderType('mock', createMockProvider);
      // Should not throw — type is registered
    });

    it('rejects duplicate type registration', () => {
      registerProviderType('dupe-test', createMockProvider);
      expect(() => registerProviderType('dupe-test', createMockProvider)).toThrow(
        SecretError
      );
    });
  });

  describe('createProvider', () => {
    it('creates and initializes a provider instance', async () => {
      registerProviderType('mock-create', createMockProvider);
      const provider = await createProvider({
        name: 'test-instance',
        type: 'mock-create',
        config: {},
      });

      expect(provider).toBeDefined();
      expect(provider.name).toBe('test-instance');
    });

    it('throws CONFIG_ERROR for unknown provider type', async () => {
      try {
        await createProvider({
          name: 'bad',
          type: 'nonexistent-type',
          config: {},
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SecretError);
        expect((err as SecretError).code).toBe(SecretErrorCode.CONFIG_ERROR);
        expect((err as SecretError).message).toContain('nonexistent-type');
      }
    });

    it('propagates initialization errors', async () => {
      registerProviderType('broken', createBrokenProvider);
      await expect(
        createProvider({ name: 'will-fail', type: 'broken', config: {} })
      ).rejects.toThrow('connection refused');
    });
  });

  describe('getProvider', () => {
    it('retrieves a registered provider by name', async () => {
      registerProviderType('mock-get', createMockProvider);
      await createProvider({
        name: 'my-provider',
        type: 'mock-get',
        config: {},
      });

      const provider = getProvider('my-provider');
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('my-provider');
    });

    it('returns undefined for unregistered name', () => {
      expect(getProvider('does-not-exist')).toBeUndefined();
    });
  });

  describe('resolveSecret', () => {
    it('resolves a plain path using the default provider', async () => {
      registerProviderType('mock-resolve', createMockProvider);
      const provider = await createProvider({
        name: 'local',
        type: 'mock-resolve',
        config: {},
      });

      await provider.setSecret!('api/key', 'secret-123');
      const value = await resolveSecret('api/key');
      expect(value).toBe('secret-123');
    });

    it('resolves a URI with explicit provider scheme', async () => {
      registerProviderType('mock-uri', createMockProvider);
      const provider = await createProvider({
        name: 'vault',
        type: 'mock-uri',
        config: {},
      });

      await provider.setSecret!('db/password', 'pg-pass');
      const value = await resolveSecret('vault://db/password');
      expect(value).toBe('pg-pass');
    });

    it('returns null for non-existent secret', async () => {
      registerProviderType('mock-null', createMockProvider);
      await createProvider({
        name: 'local',
        type: 'mock-null',
        config: {},
      });

      const value = await resolveSecret('does/not/exist');
      expect(value).toBeNull();
    });

    it('throws when referenced provider does not exist', async () => {
      try {
        await resolveSecret('missing-provider://some/path');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SecretError);
        expect((err as SecretError).code).toBe(SecretErrorCode.CONFIG_ERROR);
        expect((err as SecretError).message).toContain('missing-provider');
      }
    });

    it('uses custom default provider name', async () => {
      registerProviderType('mock-default', createMockProvider);
      const provider = await createProvider({
        name: 'my-default',
        type: 'mock-default',
        config: {},
      });

      await provider.setSecret!('token', 'abc');
      const value = await resolveSecret('token', 'my-default');
      expect(value).toBe('abc');
    });
  });

  describe('healthCheckAll', () => {
    it('returns health for all registered providers', async () => {
      registerProviderType('mock-health', createMockProvider);
      await createProvider({ name: 'alpha', type: 'mock-health', config: {} });
      await createProvider({ name: 'beta', type: 'mock-health', config: {} });

      const results = await healthCheckAll();
      expect(results.size).toBe(2);
      expect(results.get('alpha')?.healthy).toBe(true);
      expect(results.get('beta')?.healthy).toBe(true);
    });

    it('returns empty map when no providers registered', async () => {
      const results = await healthCheckAll();
      expect(results.size).toBe(0);
    });
  });

  describe('disposeAll', () => {
    it('disposes all providers and clears registry', async () => {
      registerProviderType('mock-dispose', createMockProvider);
      await createProvider({ name: 'temp', type: 'mock-dispose', config: {} });

      expect(getProvider('temp')).toBeDefined();
      await disposeAll();
      expect(getProvider('temp')).toBeUndefined();
    });

    it('is safe to call when registry is empty', async () => {
      await expect(disposeAll()).resolves.toBeUndefined();
    });
  });
});

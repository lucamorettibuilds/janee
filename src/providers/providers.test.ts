/**
 * Tests for the Secrets Provider system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { 
  parseProviderURI,
  createProvider,
  getProvider,
  resolveSecret,
  healthCheckAll,
  disposeAll,
  registerProviderType,
} from './registry';
import { FilesystemProvider } from './filesystem';
import { EnvProvider } from './env';
import { generateMasterKey, encryptSecret, decryptSecret } from '../core/crypto';

// ─── URI Parsing ─────────────────────────────────────────

describe('parseProviderURI', () => {
  it('parses scheme://path URIs', () => {
    expect(parseProviderURI('vault://mcp/stripe/key')).toEqual({
      provider: 'vault',
      path: 'mcp/stripe/key',
    });
  });

  it('handles dashes and underscores in provider names', () => {
    expect(parseProviderURI('aws-secrets://prod/db-password')).toEqual({
      provider: 'aws-secrets',
      path: 'prod/db-password',
    });
  });

  it('returns null provider for plain paths', () => {
    expect(parseProviderURI('stripe-api-key')).toEqual({
      provider: null,
      path: 'stripe-api-key',
    });
  });

  it('returns null provider for paths with slashes but no scheme', () => {
    expect(parseProviderURI('secrets/stripe/key')).toEqual({
      provider: null,
      path: 'secrets/stripe/key',
    });
  });

  it('handles env:// URIs', () => {
    expect(parseProviderURI('env://STRIPE_API_KEY')).toEqual({
      provider: 'env',
      path: 'STRIPE_API_KEY',
    });
  });
});

// ─── Environment Provider ────────────────────────────────

describe('EnvProvider', () => {
  let provider: EnvProvider;

  beforeEach(async () => {
    provider = new EnvProvider({
      name: 'test-env',
      type: 'env',
      config: {},
    });
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.dispose();
    delete process.env.TEST_SECRET_VALUE;
    delete process.env.JANEE_DB_PASSWORD;
  });

  it('reads existing environment variables', async () => {
    process.env.TEST_SECRET_VALUE = 'super-secret-123';
    expect(await provider.getSecret('TEST_SECRET_VALUE')).toBe('super-secret-123');
  });

  it('returns null for missing variables', async () => {
    expect(await provider.getSecret('NONEXISTENT_VAR_XYZ')).toBeNull();
  });

  it('supports prefix configuration', async () => {
    const prefixed = new EnvProvider({
      name: 'prefixed',
      type: 'env',
      config: { prefix: 'JANEE_' },
    });
    await prefixed.initialize();

    process.env.JANEE_DB_PASSWORD = 'db-pass-456';
    expect(await prefixed.getSecret('DB_PASSWORD')).toBe('db-pass-456');

    await prefixed.dispose();
  });

  it('throws when required var is missing', async () => {
    const strict = new EnvProvider({
      name: 'strict',
      type: 'env',
      config: { required: true },
    });
    await strict.initialize();

    await expect(strict.getSecret('MISSING_REQUIRED_VAR'))
      .rejects.toThrow('required environment variable');

    await strict.dispose();
  });

  it('lists matching environment variables', async () => {
    process.env.TEST_SECRET_VALUE = 'a';
    const secrets = await provider.listSecrets('TEST_SECRET');
    expect(secrets).toContain('TEST_SECRET_VALUE');
  });

  it('health check always passes', async () => {
    const result = await provider.healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('throws if not initialized', async () => {
    const uninitialized = new EnvProvider({
      name: 'raw',
      type: 'env',
      config: {},
    });
    await expect(uninitialized.getSecret('FOO')).rejects.toThrow('not initialized');
  });
});

// ─── Filesystem Provider ─────────────────────────────────

describe('FilesystemProvider', () => {
  let provider: FilesystemProvider;
  let tmpDir: string;
  let masterKey: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janee-test-'));
    masterKey = generateMasterKey();
    
    provider = new FilesystemProvider({
      name: 'test-fs',
      type: 'filesystem',
      config: { path: tmpDir, masterKey },
    });
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves secrets', async () => {
    await provider.setSecret!('stripe/api-key', 'sk_test_abc123');
    const value = await provider.getSecret('stripe/api-key');
    expect(value).toBe('sk_test_abc123');
  });

  it('returns null for missing secrets', async () => {
    const value = await provider.getSecret('nonexistent');
    expect(value).toBeNull();
  });

  it('encrypts secrets on disk', async () => {
    await provider.setSecret!('sensitive', 'plaintext-value');
    
    const filePath = path.join(tmpDir, 'sensitive');
    const raw = fs.readFileSync(filePath, 'utf8');
    
    // Raw file should NOT contain plaintext
    expect(raw).not.toContain('plaintext-value');
    // But should be decryptable
    expect(decryptSecret(raw, masterKey)).toBe('plaintext-value');
  });

  it('handles nested paths', async () => {
    await provider.setSecret!('services/stripe/api-key', 'sk_abc');
    await provider.setSecret!('services/github/token', 'ghp_xyz');
    
    expect(await provider.getSecret('services/stripe/api-key')).toBe('sk_abc');
    expect(await provider.getSecret('services/github/token')).toBe('ghp_xyz');
  });

  it('deletes secrets', async () => {
    await provider.setSecret!('to-delete', 'bye');
    expect(await provider.getSecret('to-delete')).toBe('bye');
    
    await provider.deleteSecret!('to-delete');
    expect(await provider.getSecret('to-delete')).toBeNull();
  });

  it('lists secrets', async () => {
    await provider.setSecret!('a', '1');
    await provider.setSecret!('b/c', '2');
    await provider.setSecret!('b/d', '3');
    
    const all = await provider.listSecrets!();
    expect(all.sort()).toEqual(['a', 'b/c', 'b/d'].sort());
    
    const filtered = await provider.listSecrets!('b');
    expect(filtered.sort()).toEqual(['b/c', 'b/d'].sort());
  });

  it('passes health check for valid directory', async () => {
    const result = await provider.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeDefined();
  });

  it('fails health check for missing directory', async () => {
    const bad = new FilesystemProvider({
      name: 'bad',
      type: 'filesystem',
      config: { path: '/nonexistent/path/xyz', masterKey },
    });
    // Don't initialize — just health check
    const result = await bad.healthCheck();
    expect(result.healthy).toBe(false);
  });

  it('prevents path traversal', async () => {
    await provider.setSecret!('legit', 'safe');
    
    // Attempt path traversal — should be normalized
    const value = await provider.getSecret('../../etc/passwd');
    expect(value).toBeNull(); // Should not read /etc/passwd
  });

  it('throws on invalid master key', () => {
    expect(() => new FilesystemProvider({
      name: 'bad-key',
      type: 'filesystem',
      config: { path: tmpDir, masterKey: '' },
    })).toThrow('masterKey is required');
  });
});

// ─── Registry ────────────────────────────────────────────

describe('Provider Registry', () => {
  afterEach(async () => {
    await disposeAll();
  });

  it('creates filesystem providers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'janee-reg-'));
    const masterKey = generateMasterKey();

    const provider = await createProvider({
      name: 'local',
      type: 'filesystem',
      config: { path: tmpDir, masterKey },
    });

    expect(provider.name).toBe('local');
    expect(provider.type).toBe('filesystem');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates env providers', async () => {
    const provider = await createProvider({
      name: 'ci',
      type: 'env',
      config: {},
    });

    expect(provider.name).toBe('ci');
    expect(provider.type).toBe('env');
  });

  it('resolves secrets by URI', async () => {
    process.env.TEST_RESOLVE = 'resolved-value';

    await createProvider({ name: 'myenv', type: 'env', config: {} });
    
    const value = await resolveSecret('myenv://TEST_RESOLVE');
    expect(value).toBe('resolved-value');

    delete process.env.TEST_RESOLVE;
  });

  it('uses default provider for plain paths', async () => {
    process.env.PLAIN_PATH = 'default-resolved';

    await createProvider({ name: 'local', type: 'env', config: {} });

    const value = await resolveSecret('PLAIN_PATH', 'local');
    expect(value).toBe('default-resolved');

    delete process.env.PLAIN_PATH;
  });

  it('throws for unknown provider type', async () => {
    await expect(createProvider({
      name: 'bad',
      type: 'nonexistent-type',
      config: {},
    })).rejects.toThrow('Unknown provider type');
  });

  it('throws for unregistered provider name in resolveSecret', async () => {
    await expect(resolveSecret('missing://secret'))
      .rejects.toThrow('Provider "missing" not found');
  });

  it('health checks all providers', async () => {
    await createProvider({ name: 'env1', type: 'env', config: {} });
    await createProvider({ name: 'env2', type: 'env', config: {} });

    const results = await healthCheckAll();
    expect(results.env1.healthy).toBe(true);
    expect(results.env2.healthy).toBe(true);
  });

  it('retrieves providers by name', async () => {
    await createProvider({ name: 'lookup-test', type: 'env', config: {} });
    
    const provider = getProvider('lookup-test');
    expect(provider).toBeDefined();
    expect(provider!.name).toBe('lookup-test');
  });
});

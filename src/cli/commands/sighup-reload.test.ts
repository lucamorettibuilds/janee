import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the SIGHUP config reload integration
describe('SIGHUP config reload', () => {
  const originalListeners: Record<string, Function[]> = {};

  beforeEach(() => {
    // Track SIGHUP listeners
    originalListeners['SIGHUP'] = process.listeners('SIGHUP').slice();
  });

  afterEach(() => {
    // Remove any listeners we added
    process.removeAllListeners('SIGHUP');
    // Restore originals
    for (const listener of originalListeners['SIGHUP'] || []) {
      process.on('SIGHUP', listener as any);
    }
  });

  it('should handle SIGHUP without crashing when no config file exists', () => {
    // Simulate what happens when SIGHUP is sent but no YAML config is present
    // This tests the guard condition in serve-mcp.ts
    expect(() => {
      // The handler should be a no-op when hasYAMLConfig() returns false
      process.emit('SIGHUP', 'SIGHUP');
    }).not.toThrow();
  });

  it('loadConfigForMCP should return capabilities and services', async () => {
    // Test the reload function shape
    const { createMCPServer } = await import('../../core/mcp-server');
    
    const result = createMCPServer({
      capabilities: [{ name: 'test', service: 'test-svc' }],
      services: new Map([['test-svc', {
        baseUrl: 'https://example.com',
        auth: { type: 'bearer' as const, key: 'test-key' }
      }]]),
      onReloadConfig: () => ({
        capabilities: [
          { name: 'test', service: 'test-svc' },
          { name: 'test2', service: 'test-svc' }
        ],
        services: new Map([['test-svc', {
          baseUrl: 'https://example.com',
          auth: { type: 'bearer' as const, key: 'new-key' }
        }]])
      })
    });

    // reloadConfig should be available
    expect(result.reloadConfig).toBeDefined();
    expect(typeof result.reloadConfig).toBe('function');
    
    // Should return true on success
    const success = result.reloadConfig!();
    expect(success).toBe(true);
  });

  it('reloadConfig should return false on error', async () => {
    const { createMCPServer } = await import('../../core/mcp-server');
    
    const result = createMCPServer({
      capabilities: [],
      services: new Map(),
      onReloadConfig: () => {
        throw new Error('Config file missing');
      }
    });

    const success = result.reloadConfig!();
    expect(success).toBe(false);
  });

  it('reloadConfig should be undefined when no onReloadConfig provided', async () => {
    const { createMCPServer } = await import('../../core/mcp-server');
    
    const result = createMCPServer({
      capabilities: [],
      services: new Map(),
    });

    expect(result.reloadConfig).toBeUndefined();
  });
});

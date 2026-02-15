import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the config module
vi.mock('../config-yaml', () => ({
  hasYAMLConfig: vi.fn(),
  loadYAMLConfig: vi.fn(),
}));

import { hasYAMLConfig, loadYAMLConfig } from '../config-yaml';
import { getCommand } from './get';

const mockHasYAMLConfig = vi.mocked(hasYAMLConfig);
const mockLoadYAMLConfig = vi.mocked(loadYAMLConfig);

describe('get command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockHasYAMLConfig.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeConfig = (services: Record<string, any> = {}) => ({
    version: '1',
    masterKey: 'test-key',
    server: { port: 3000, host: 'localhost' },
    services,
    capabilities: {},
  });

  it('should output bearer token for bearer auth service', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      github: {
        baseUrl: 'https://api.github.com',
        auth: { type: 'bearer', key: 'ghp_test123' },
      },
    }));

    await getCommand('github');

    expect(consoleSpy).toHaveBeenCalledWith('ghp_test123');
  });

  it('should output apiKey for hmac auth service', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      mexc: {
        baseUrl: 'https://api.mexc.com',
        auth: { type: 'hmac-mexc', apiKey: 'mx_key_123', apiSecret: 'mx_secret_456' },
      },
    }));

    await getCommand('mexc');

    expect(consoleSpy).toHaveBeenCalledWith('mx_key_123');
  });

  it('should output apiSecret when explicitly requested', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      mexc: {
        baseUrl: 'https://api.mexc.com',
        auth: { type: 'hmac-mexc', apiKey: 'mx_key_123', apiSecret: 'mx_secret_456' },
      },
    }));

    await getCommand('mexc', 'apiSecret');

    expect(consoleSpy).toHaveBeenCalledWith('mx_secret_456');
  });

  it('should output baseUrl when requested', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      github: {
        baseUrl: 'https://api.github.com',
        auth: { type: 'bearer', key: 'ghp_test123' },
      },
    }));

    await getCommand('github', 'baseUrl');

    expect(consoleSpy).toHaveBeenCalledWith('https://api.github.com');
  });

  it('should output JSON when --json flag is set', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      github: {
        baseUrl: 'https://api.github.com',
        auth: { type: 'bearer', key: 'ghp_test123' },
      },
    }));

    await getCommand('github', undefined, { json: true });

    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.service).toBe('github');
    expect(output.field).toBe('key');
    expect(output.value).toBe('ghp_test123');
  });

  it('should exit with error for unknown service', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      github: {
        baseUrl: 'https://api.github.com',
        auth: { type: 'bearer', key: 'ghp_test123' },
      },
    }));

    await expect(getCommand('nonexistent')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('should exit with error when no service name provided', async () => {
    await expect(getCommand()).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('should exit with error when config not initialized', async () => {
    mockHasYAMLConfig.mockReturnValue(false);

    await expect(getCommand('github')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Run `janee init`'));
  });

  it('should accept "token" as alias for "key"', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      github: {
        baseUrl: 'https://api.github.com',
        auth: { type: 'bearer', key: 'ghp_test123' },
      },
    }));

    await getCommand('github', 'token');

    expect(consoleSpy).toHaveBeenCalledWith('ghp_test123');
  });

  it('should accept "secret" as alias for "apiSecret"', async () => {
    mockLoadYAMLConfig.mockReturnValue(makeConfig({
      mexc: {
        baseUrl: 'https://api.mexc.com',
        auth: { type: 'hmac-mexc', apiKey: 'mx_key_123', apiSecret: 'mx_secret_456' },
      },
    }));

    await getCommand('mexc', 'secret');

    expect(consoleSpy).toHaveBeenCalledWith('mx_secret_456');
  });
});

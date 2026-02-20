import { describe, it, expect } from 'vitest';
import {
  verifyAgentSecret,
  requiresVerification,
  authenticateAgent,
} from './agent-registry.js';

describe('verifyAgentSecret', () => {
  it('returns true for matching secrets', () => {
    expect(verifyAgentSecret('my-secret-123', 'my-secret-123')).toBe(true);
  });

  it('returns false for non-matching secrets', () => {
    expect(verifyAgentSecret('my-secret-123', 'wrong-secret')).toBe(false);
  });

  it('returns false for different length secrets', () => {
    expect(verifyAgentSecret('short', 'a-much-longer-secret')).toBe(false);
  });
});

describe('requiresVerification', () => {
  it('returns false when disabled', () => {
    expect(requiresVerification(false, 'http')).toBe(false);
    expect(requiresVerification(undefined, 'http')).toBe(false);
  });

  it('returns true for http transport when set to http', () => {
    expect(requiresVerification('http', 'http')).toBe(true);
  });

  it('returns false for stdio transport when set to http', () => {
    expect(requiresVerification('http', 'stdio')).toBe(false);
  });

  it('returns true for all transports when set to all', () => {
    expect(requiresVerification('all', 'http')).toBe(true);
    expect(requiresVerification('all', 'stdio')).toBe(true);
  });
});

describe('authenticateAgent', () => {
  const agents = {
    'creature:secure': { secret: 'secret-abc-123' },
    'creature:voyager': { secret: 'secret-xyz-456' },
  };

  it('authenticates a valid agent', () => {
    const result = authenticateAgent('creature:secure', { secret: 'secret-abc-123' }, agents);
    expect(result).toEqual({ verified: true, agentId: 'creature:secure' });
  });

  it('rejects wrong secret', () => {
    const result = authenticateAgent('creature:secure', { secret: 'wrong' }, agents);
    expect(result).toEqual({ verified: false, reason: 'Invalid secret' });
  });

  it('rejects unknown agent', () => {
    const result = authenticateAgent('creature:unknown', { secret: 'anything' }, agents);
    expect(result).toEqual({ verified: false, reason: "Agent 'creature:unknown' not found in registry" });
  });

  it('rejects missing auth payload', () => {
    const result = authenticateAgent('creature:secure', undefined, agents);
    expect(result).toEqual({ verified: false, reason: 'No _auth.secret provided in initialize params' });
  });

  it('rejects missing agent ID', () => {
    const result = authenticateAgent(undefined, { secret: 'secret-abc-123' }, agents);
    expect(result).toEqual({ verified: false, reason: 'No agent ID provided in clientInfo.name' });
  });

  it('rejects when no registry exists', () => {
    const result = authenticateAgent('creature:secure', { secret: 'secret-abc-123' }, undefined);
    expect(result).toEqual({ verified: false, reason: "Agent 'creature:secure' not found in registry" });
  });
});

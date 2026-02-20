/**
 * Agent registry — session-bound verified authentication for HTTP agents.
 *
 * When `requireVerifiedIdentity` is set, HTTP clients must authenticate
 * during the MCP initialize handshake by sending `_auth.secret` alongside
 * their `clientInfo`. The secret is verified against the agent registry
 * in config.yaml. On success, `verifiedAgentId` is stored in the session
 * metadata (Priority 1 in resolveAgentIdentity), making it impossible for
 * an HTTP client to impersonate another agent.
 *
 * Stdio clients are trusted by transport and do not need registry entries.
 *
 * @see https://github.com/rsdouglas/janee/issues/96
 */

import * as crypto from 'node:crypto';

export interface AgentEntry {
  /** Encrypted or plaintext secret for this agent */
  secret: string;
}

export interface AgentRegistryConfig {
  /** Map of agent ID → agent entry */
  agents?: Record<string, AgentEntry>;
  /** When to require verified identity: 'http' | 'all' | false */
  requireVerifiedIdentity?: 'http' | 'all' | false;
}

/**
 * Verify an agent's claimed identity against the registry.
 *
 * @param agentId - The claimed agent ID (from clientInfo.name)
 * @param secret - The secret provided in _auth.secret
 * @param registeredSecret - The decrypted secret from the agent registry
 * @returns true if the secret matches
 */
export function verifyAgentSecret(
  secret: string,
  registeredSecret: string
): boolean {
  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(secret);
  const b = Buffer.from(registeredSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Check whether a transport requires verified identity.
 *
 * @param requireVerifiedIdentity - The config setting
 * @param transportType - 'http' | 'stdio'
 * @returns true if identity verification is required for this transport
 */
export function requiresVerification(
  requireVerifiedIdentity: 'http' | 'all' | false | undefined,
  transportType: 'http' | 'stdio'
): boolean {
  if (!requireVerifiedIdentity) return false;
  if (requireVerifiedIdentity === 'all') return true;
  if (requireVerifiedIdentity === 'http' && transportType === 'http') return true;
  return false;
}

/**
 * Attempt to authenticate an agent during the initialize handshake.
 *
 * @param agentId - The claimed agent ID (from clientInfo.name)
 * @param authPayload - The _auth object from initialize params
 * @param agents - The agent registry from config
 * @returns { verified: true, agentId } on success, { verified: false, reason } on failure
 */
export function authenticateAgent(
  agentId: string | undefined,
  authPayload: { secret?: string } | undefined,
  agents: Record<string, AgentEntry> | undefined
): { verified: true; agentId: string } | { verified: false; reason: string } {
  if (!agentId) {
    return { verified: false, reason: 'No agent ID provided in clientInfo.name' };
  }

  if (!authPayload?.secret) {
    return { verified: false, reason: 'No _auth.secret provided in initialize params' };
  }

  if (!agents || !agents[agentId]) {
    return { verified: false, reason: `Agent '${agentId}' not found in registry` };
  }

  const registeredSecret = agents[agentId].secret;

  if (verifyAgentSecret(authPayload.secret, registeredSecret)) {
    return { verified: true, agentId };
  }

  return { verified: false, reason: 'Invalid secret' };
}

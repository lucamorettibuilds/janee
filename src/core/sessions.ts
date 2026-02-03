/**
 * Session management for Janee
 * Tracks active capability sessions with TTL
 */

import { generateToken } from './crypto';

export interface Session {
  id: string;
  capability: string;
  service: string;
  agentId?: string;
  reason?: string;
  createdAt: Date;
  expiresAt: Date;
  revoked: boolean;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * Create a new session for a capability
   */
  createSession(
    capability: string,
    service: string,
    ttlSeconds: number,
    options: { agentId?: string; reason?: string } = {}
  ): Session {
    const id = generateToken('jnee_sess', 32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const session: Session = {
      id,
      capability,
      service,
      agentId: options.agentId,
      reason: options.reason,
      createdAt: now,
      expiresAt,
      revoked: false
    };

    this.sessions.set(id, session);

    // Schedule cleanup
    setTimeout(() => {
      this.sessions.delete(id);
    }, ttlSeconds * 1000);

    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return undefined;
    }

    // Check expiry
    if (session.revoked || new Date() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Revoke a session immediately
   */
  revokeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    session.revoked = true;
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * List all active sessions
   */
  listSessions(): Session[] {
    const now = new Date();
    const active: Session[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (!session.revoked && now <= session.expiresAt) {
        active.push(session);
      } else {
        // Clean up expired
        this.sessions.delete(id);
      }
    }

    return active;
  }

  /**
   * Clean up expired sessions
   */
  cleanup(): void {
    const now = new Date();
    
    for (const [id, session] of this.sessions.entries()) {
      if (session.revoked || now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }
}

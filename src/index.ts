/**
 * Janee library exports for programmatic config management.
 *
 * Use these to read/write Janee configuration from an orchestrator
 * or integration that manages Janee as a child process. After mutations,
 * send SIGHUP to the running Janee process to reload config in-memory.
 */

// Config types
export type {
  AuthConfig,
  CapabilityConfig,
  JaneeConfig,
  JaneeYAMLConfig,
  LLMConfig,
  ServerConfig,
  ServiceConfig,
} from './cli/config-store';

// Config read/write (new names)
export {
  addCapability,
  addService,
  createServiceWithOwnership,
  getConfigDir,
  hasConfig,
  initConfig,
  loadConfig,
  persistServiceOwnership,
  saveConfig,
} from './cli/config-store';

// Deprecated aliases for backwards compatibility
export {
  addCapabilityYAML,
  addServiceYAML,
  hasYAMLConfig,
  initYAMLConfig,
  loadYAMLConfig,
  saveYAMLConfig,
} from './cli/config-store';

// Agent scope / ownership
export type {
  AccessPolicy,
  CredentialOwnership,
} from './core/agent-scope';

export {
  agentCreatedOwnership,
  canAgentAccess,
  cliCreatedOwnership,
  grantAccess,
  revokeAccess,
} from './core/agent-scope';

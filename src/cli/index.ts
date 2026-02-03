#!/usr/bin/env node

/**
 * Janee CLI
 * Secrets management for AI agents
 */

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { addCommand } from './commands/add';
import { serveCommand } from './commands/serve';
import { listCommand } from './commands/list';
import { logsCommand } from './commands/logs';
import { removeCommand } from './commands/remove';
import { migrateCommand } from './commands/migrate';
import { sessionsCommand } from './commands/sessions';
import { revokeCommand } from './commands/revoke';
import { serveMCPCommand } from './commands/serve-mcp';

const program = new Command();

program
  .name('janee')
  .description('Secrets management for AI agents')
  .version('0.1.0');

// Commands
program
  .command('init')
  .description('Initialize Janee configuration')
  .action(initCommand);

program
  .command('add <service>')
  .description('Add a service to Janee')
  .option('-u, --url <url>', 'Base URL of the service')
  .option('-k, --key <key>', 'API key for the service')
  .option('-d, --description <desc>', 'Description of the service')
  .action(addCommand);

program
  .command('serve')
  .description('Start Janee proxy server')
  .option('-p, --port <port>', 'Port to listen on (default: 9119)', '9119')
  .option('--mcp', 'Start MCP server (requires YAML config)')
  .option('--no-llm', 'Disable LLM adjudication')
  .action((options) => {
    if (options.mcp) {
      serveMCPCommand();
    } else {
      serveCommand(options);
    }
  });

program
  .command('list')
  .description('List configured services')
  .action(listCommand);

program
  .command('logs')
  .description('View audit logs')
  .option('-f, --follow', 'Follow logs in real-time')
  .option('-n, --lines <count>', 'Number of recent logs to show', '20')
  .option('-s, --service <name>', 'Filter by service')
  .action(logsCommand);

program
  .command('remove <service>')
  .description('Remove a service from Janee')
  .action(removeCommand);

program
  .command('migrate')
  .description('Migrate config from JSON to YAML (for MCP support)')
  .action(migrateCommand);

program
  .command('sessions')
  .description('List active sessions')
  .action(sessionsCommand);

program
  .command('revoke <session>')
  .description('Revoke a session immediately')
  .action(revokeCommand);

program.parse();

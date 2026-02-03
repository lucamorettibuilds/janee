/**
 * MCP Server for Janee
 * Exposes capabilities to AI agents via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from './sessions.js';
import { ProxyRequest, ProxyResponse } from './proxy.js';

export interface Capability {
  name: string;
  service: string;
  ttl: string;  // e.g., "1h", "30m"
  autoApprove?: boolean;
  requiresReason?: boolean;
}

export interface ServiceConfig {
  baseUrl: string;
  auth: {
    type: 'bearer' | 'hmac' | 'headers';
    key?: string;
    apiKey?: string;
    apiSecret?: string;
    headers?: Record<string, string>;
  };
}

export interface MCPServerOptions {
  capabilities: Capability[];
  services: Map<string, ServiceConfig>;
  sessionManager: SessionManager;
  proxyUrl: string;
  onExecute: (session: any, request: ProxyRequest) => Promise<ProxyResponse>;
}

/**
 * Parse TTL string to seconds
 */
function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400
  };
  
  return value * multipliers[unit];
}

/**
 * Create and start MCP server
 */
export function createMCPServer(options: MCPServerOptions): Server {
  const { capabilities, services, sessionManager, proxyUrl, onExecute } = options;

  const server = new Server(
    {
      name: 'janee',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Tool: list_services
  const listServicesTool: Tool = {
    name: 'list_services',
    description: 'List available API capabilities managed by Janee',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  };

  // Tool: execute
  const executeTool: Tool = {
    name: 'execute',
    description: 'Execute an API request through Janee proxy',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Capability name to use (from list_services)'
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP method'
        },
        path: {
          type: 'string',
          description: 'API path (e.g., /v1/customers)'
        },
        body: {
          type: 'string',
          description: 'Request body (JSON string, optional)'
        },
        headers: {
          type: 'object',
          description: 'Additional headers (optional)',
          additionalProperties: { type: 'string' }
        },
        reason: {
          type: 'string',
          description: 'Reason for this request (required for some capabilities)'
        }
      },
      required: ['capability', 'method', 'path']
    }
  };

  // Tool: get_http_access
  const getHttpAccessTool: Tool = {
    name: 'get_http_access',
    description: 'Get HTTP proxy credentials for direct API access',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Capability name to access'
        },
        reason: {
          type: 'string',
          description: 'Reason for needing access (required for some capabilities)'
        }
      },
      required: ['capability']
    }
  };

  // Register tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [listServicesTool, executeTool, getHttpAccessTool]
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'list_services':
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(
                capabilities.map(cap => ({
                  name: cap.name,
                  service: cap.service,
                  ttl: cap.ttl,
                  autoApprove: cap.autoApprove,
                  requiresReason: cap.requiresReason
                })),
                null,
                2
              )
            }]
          };

        case 'execute': {
          const { capability, method, path, body, headers, reason } = args as any;

          // Find capability
          const cap = capabilities.find(c => c.name === capability);
          if (!cap) {
            throw new Error(`Unknown capability: ${capability}`);
          }

          // Check if reason required
          if (cap.requiresReason && !reason) {
            throw new Error(`Capability "${capability}" requires a reason`);
          }

          // Get or create session
          const ttlSeconds = parseTTL(cap.ttl);
          const session = sessionManager.createSession(
            cap.name,
            cap.service,
            ttlSeconds,
            { reason }
          );

          // Build proxy request
          const proxyReq: ProxyRequest = {
            service: cap.service,
            path,
            method,
            headers: headers || {},
            body
          };

          // Execute
          const response = await onExecute(session, proxyReq);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: response.statusCode,
                body: response.body
              }, null, 2)
            }]
          };
        }

        case 'get_http_access': {
          const { capability, reason } = args as any;

          // Find capability
          const cap = capabilities.find(c => c.name === capability);
          if (!cap) {
            throw new Error(`Unknown capability: ${capability}`);
          }

          // Check if reason required
          if (cap.requiresReason && !reason) {
            throw new Error(`Capability "${capability}" requires a reason`);
          }

          // Create session
          const ttlSeconds = parseTTL(cap.ttl);
          const session = sessionManager.createSession(
            cap.name,
            cap.service,
            ttlSeconds,
            { reason }
          );

          // Return HTTP credentials
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                url: `${proxyUrl}/${cap.service}`,
                headers: {
                  Authorization: `Bearer ${session.id}`
                },
                expires: session.expiresAt.toISOString()
              }, null, 2)
            }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown error'
          }, null, 2)
        }],
        isError: true
      };
    }
  });

  return server;
}

/**
 * Start MCP server with stdio transport
 */
export async function startMCPServer(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Janee MCP server started');
}

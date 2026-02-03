import { loadYAMLConfig, hasYAMLConfig } from '../config-yaml';
import { createMCPServer, startMCPServer, Capability, ServiceConfig } from '../../core/mcp-server';
import { SessionManager } from '../../core/sessions';
import { ProxyRequest, ProxyResponse } from '../../core/proxy';
import { AuditLogger } from '../../core/audit';
import { getAuditDir } from '../config';
import https from 'https';
import http from 'http';
import { URL } from 'url';

export async function serveMCPCommand(): Promise<void> {
  try {
    // Check for YAML config
    if (!hasYAMLConfig()) {
      console.error('❌ YAML config required for MCP mode');
      console.error('');
      console.error('Run: janee migrate');
      console.error('Or: janee init (for new setup)');
      process.exit(1);
    }

    const config = loadYAMLConfig();
    const sessionManager = new SessionManager();
    const auditLogger = new AuditLogger(getAuditDir());

    // Convert config to MCP format
    const capabilities: Capability[] = Object.entries(config.capabilities).map(
      ([name, cap]) => ({
        name,
        service: cap.service,
        ttl: cap.ttl,
        autoApprove: cap.autoApprove,
        requiresReason: cap.requiresReason
      })
    );

    const services = new Map<string, ServiceConfig>();
    for (const [name, service] of Object.entries(config.services)) {
      services.set(name, service);
    }

    // Create MCP server
    const mcpServer = createMCPServer({
      capabilities,
      services,
      sessionManager,
      proxyUrl: `http://${config.server.host}:${config.server.port}`,
      
      onExecute: async (session, request) => {
        // Get service config
        const serviceConfig = services.get(request.service);
        if (!serviceConfig) {
          throw new Error(`Service not found: ${request.service}`);
        }

        // Build target URL
        const targetUrl = new URL(request.path, serviceConfig.baseUrl);

        // Build headers
        const headers: Record<string, string> = { ...request.headers };

        // Inject auth
        if (serviceConfig.auth.type === 'bearer' && serviceConfig.auth.key) {
          headers['Authorization'] = `Bearer ${serviceConfig.auth.key}`;
        } else if (serviceConfig.auth.type === 'headers' && serviceConfig.auth.headers) {
          Object.assign(headers, serviceConfig.auth.headers);
        }
        // TODO: HMAC signature support

        // Make request
        const client = targetUrl.protocol === 'https:' ? https : http;
        
        const response = await new Promise<ProxyResponse>((resolve, reject) => {
          const req = client.request(targetUrl, {
            method: request.method,
            headers
          }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode || 500,
                headers: res.headers as Record<string, string | string[]>,
                body
              });
            });
          });

          req.on('error', reject);

          if (request.body) {
            req.write(request.body);
          }

          req.end();
        });

        // Log to audit
        auditLogger.log(request, response);

        return response;
      }
    });

    // Start server
    await startMCPServer(mcpServer);

  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error:', error.message);
    } else {
      console.error('❌ Unknown error occurred');
    }
    process.exit(1);
  }
}

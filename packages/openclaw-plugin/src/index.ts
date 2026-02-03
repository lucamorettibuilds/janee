import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;
let isConnecting = false;

async function ensureConnected(api: any) {
  if (mcpClient) return mcpClient;
  
  // Prevent multiple simultaneous connection attempts
  if (isConnecting) {
    // Wait for the connection to complete
    while (isConnecting) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (mcpClient) return mcpClient;
  }
  
  isConnecting = true;
  
  try {
    // Spawn janee serve --mcp and connect via stdio
    const transport = new StdioClientTransport({
      command: "janee",
      args: ["serve", "--mcp"]
    });
    
    mcpClient = new Client(
      { name: "openclaw-janee", version: "0.1.0" },
      { capabilities: {} }
    );
    
    await mcpClient.connect(transport);
    api.log?.info?.("Connected to Janee MCP server");
    return mcpClient;
  } catch (error) {
    api.log?.error?.(`Failed to connect to Janee MCP server: ${error}`);
    throw error;
  } finally {
    isConnecting = false;
  }
}

export default function(api: any) {
  
  api.registerTool({
    name: "janee_list_services",
    description: "List available API services managed by Janee. Shows which services have stored credentials.",
    parameters: Type.Object({}),
    async execute() {
      const client = await ensureConnected(api);
      const result = await client.callTool({ name: "list_services", arguments: {} });
      return { content: result.content };
    }
  });

  api.registerTool({
    name: "janee_execute", 
    description: "Execute an API request through Janee proxy with stored credentials. Use janee_list_services first to see available services. All requests are logged for audit.",
    parameters: Type.Object({
      service: Type.String({ description: "Service name from janee_list_services (e.g., 'stripe', 'github', 'bybit')" }),
      method: Type.String({ description: "HTTP method: GET, POST, PUT, DELETE, PATCH" }),
      path: Type.String({ description: "API path (e.g., '/v1/customers' for Stripe)" }),
      body: Type.Optional(Type.String({ description: "Request body as JSON string" })),
      reason: Type.Optional(Type.String({ description: "Reason for this request (for audit logs, may be required for sensitive operations)" })),
    }),
    async execute(_id: string, params: any) {
      const client = await ensureConnected(api);
      const result = await client.callTool({ 
        name: "execute", 
        arguments: {
          capability: params.service,
          method: params.method,
          path: params.path,
          body: params.body,
          reason: params.reason,
        }
      });
      return { content: result.content };
    }
  });

  api.registerTool({
    name: "janee_get_http_access",
    description: "Get HTTP proxy URL and token for direct API access (useful for scripts or curl commands that need raw HTTP access). Returns proxy endpoint and authorization header.",
    parameters: Type.Object({
      service: Type.String({ description: "Service name (e.g., 'stripe', 'github')" }),
      reason: Type.Optional(Type.String({ description: "Reason for requesting access (for audit logs)" })),
    }),
    async execute(_id: string, params: any) {
      const client = await ensureConnected(api);
      const result = await client.callTool({
        name: "get_http_access",
        arguments: {
          capability: params.service,
          reason: params.reason,
        }
      });
      return { content: result.content };
    }
  });

  // Clean up on shutdown
  api.on?.("shutdown", async () => {
    if (mcpClient) {
      await mcpClient.close();
      mcpClient = null;
    }
  });
}

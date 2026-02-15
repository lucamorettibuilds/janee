import { loadYAMLConfig, hasYAMLConfig } from '../config-yaml';

/**
 * Get a secret value for a service
 * Usage: janee get <service> [field]
 * 
 * Fields: key, apiKey, apiSecret, passphrase, baseUrl
 * Default field: key (for bearer auth) or apiKey (for hmac auth)
 * 
 * Outputs only the raw value (no labels) for easy scripting:
 *   TOKEN=$(janee get github)
 */
export async function getCommand(
  serviceName?: string,
  field?: string,
  options: { json?: boolean } = {}
): Promise<void> {
  try {
    if (!hasYAMLConfig()) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'No config found' }, null, 2));
      } else {
        console.error('No config found. Run `janee init` first.');
      }
      process.exit(1);
    }

    if (!serviceName) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Service name required' }, null, 2));
      } else {
        console.error('Usage: janee get <service> [field]');
        console.error('');
        console.error('Fields: key, apiKey, apiSecret, passphrase, baseUrl');
        console.error('');
        console.error('Examples:');
        console.error('  janee get github           # Get the API key/token');
        console.error('  janee get github key       # Get the bearer token');
        console.error('  janee get mexc apiSecret   # Get the HMAC secret');
        console.error('  janee get github baseUrl   # Get the base URL');
        console.error('  janee get github --json    # JSON output');
      }
      process.exit(1);
    }

    const config = loadYAMLConfig();
    const service = config.services[serviceName];

    if (!service) {
      const available = Object.keys(config.services).join(', ');
      if (options.json) {
        console.log(JSON.stringify({ 
          error: `Service "${serviceName}" not found`,
          available: Object.keys(config.services)
        }, null, 2));
      } else {
        console.error(`❌ Service "${serviceName}" not found.`);
        if (available) {
          console.error(`   Available services: ${available}`);
        }
      }
      process.exit(1);
    }

    // If field is 'baseUrl', return that
    if (field === 'baseUrl' || field === 'url') {
      if (options.json) {
        console.log(JSON.stringify({ service: serviceName, field: 'baseUrl', value: service.baseUrl }, null, 2));
      } else {
        console.log(service.baseUrl);
      }
      return;
    }

    // Determine which auth field to return
    const auth = service.auth;
    let value: string | undefined;
    let resolvedField: string;

    if (field) {
      // Explicit field requested
      resolvedField = field;
      switch (field) {
        case 'key':
        case 'token':
          value = auth.key;
          resolvedField = 'key';
          break;
        case 'apiKey':
          value = auth.apiKey;
          break;
        case 'apiSecret':
        case 'secret':
          value = auth.apiSecret;
          resolvedField = 'apiSecret';
          break;
        case 'passphrase':
          value = auth.passphrase;
          break;
        default:
          if (options.json) {
            console.log(JSON.stringify({ error: `Unknown field "${field}"` }, null, 2));
          } else {
            console.error(`❌ Unknown field "${field}".`);
            console.error('   Valid fields: key, token, apiKey, apiSecret, secret, passphrase, baseUrl, url');
          }
          process.exit(1);
      }
    } else {
      // Auto-detect based on auth type
      if (auth.type === 'bearer') {
        value = auth.key;
        resolvedField = 'key';
      } else if (auth.type === 'hmac-mexc' || auth.type === 'hmac-bybit' || auth.type === 'hmac-okx') {
        value = auth.apiKey;
        resolvedField = 'apiKey';
      } else if (auth.type === 'headers' && auth.headers) {
        // For header auth, return the first header value
        const entries = Object.entries(auth.headers);
        if (entries.length > 0) {
          value = entries[0][1];
          resolvedField = entries[0][0];
        } else {
          resolvedField = 'headers';
        }
      } else if (auth.type === 'service-account') {
        value = auth.credentials;
        resolvedField = 'credentials';
      } else {
        // Fallback: try key, then apiKey
        value = auth.key || auth.apiKey;
        resolvedField = auth.key ? 'key' : 'apiKey';
      }
    }

    if (!value) {
      if (options.json) {
        console.log(JSON.stringify({ 
          error: `No value found for field "${resolvedField!}" on service "${serviceName}"`,
          authType: auth.type
        }, null, 2));
      } else {
        console.error(`❌ No value for "${resolvedField!}" on service "${serviceName}" (auth type: ${auth.type}).`);
      }
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify({ 
        service: serviceName, 
        field: resolvedField!, 
        value 
      }, null, 2));
    } else {
      // Raw value only - optimized for scripting
      console.log(value);
    }

  } catch (error) {
    if (error instanceof Error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }, null, 2));
      } else {
        console.error('❌ Error:', error.message);
      }
    } else {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Unknown error occurred' }, null, 2));
      } else {
        console.error('❌ Unknown error occurred');
      }
    }
    process.exit(1);
  }
}

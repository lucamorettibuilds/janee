/**
 * HMAC Signing implementations for various exchanges/APIs
 */

import {
  createHash,
  createHmac,
  randomBytes,
} from 'crypto';

export interface SigningResult {
  headers: Record<string, string>;
  urlParams?: Record<string, string>;
}

export interface BybitSigningParams {
  apiKey: string;
  apiSecret: string;
  method: string;
  queryString: string;
  body?: string;
  timestamp?: string;
  recvWindow?: string;
}

export interface OKXSigningParams {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: string;
  requestPath: string;
  body?: string;
  timestamp?: string;
}

export interface MEXCSigningParams {
  apiKey: string;
  apiSecret: string;
  queryString: string;
  timestamp?: string;
}

/**
 * Bybit HMAC signing
 * - GET/DELETE: sign timestamp + apiKey + recvWindow + queryString
 * - POST/PUT: sign timestamp + apiKey + recvWindow + body
 */
export function signBybit(params: BybitSigningParams): SigningResult {
  const timestamp = params.timestamp || Date.now().toString();
  const recvWindow = params.recvWindow || '5000';
  const method = params.method.toUpperCase();
  
  // POST/PUT sign the body, GET/DELETE sign the query string
  const payloadData = (method === 'POST' || method === 'PUT') 
    ? (params.body || '')
    : params.queryString;
  
  const signPayload = timestamp + params.apiKey + recvWindow + payloadData;
  const signature = createHmac('sha256', params.apiSecret)
    .update(signPayload)
    .digest('hex');
  
  return {
    headers: {
      'X-BAPI-API-KEY': params.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': recvWindow
    }
  };
}

/**
 * OKX HMAC signing
 * - Always signs: timestamp + method + requestPath + body
 * - Uses base64 encoding
 */
export function signOKX(params: OKXSigningParams): SigningResult {
  const timestamp = params.timestamp || new Date().toISOString();
  const method = params.method.toUpperCase();
  const body = params.body || '';
  
  const signPayload = timestamp + method + params.requestPath + body;
  const signature = createHmac('sha256', params.apiSecret)
    .update(signPayload)
    .digest('base64');
  
  return {
    headers: {
      'OK-ACCESS-KEY': params.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': params.passphrase
    }
  };
}

/**
 * MEXC HMAC signing
 * - Signs query string with timestamp
 * - Returns signature as URL param and API key as header (X-MEXC-APIKEY)
 */
export function signMEXC(params: MEXCSigningParams): SigningResult {
  const timestamp = params.timestamp || Date.now().toString();
  
  // Add timestamp to query string for signing
  const queryWithTimestamp = params.queryString 
    ? `${params.queryString}&timestamp=${timestamp}`
    : `timestamp=${timestamp}`;
  
  const signature = createHmac('sha256', params.apiSecret)
    .update(queryWithTimestamp)
    .digest('hex');
  
  return {
    headers: {
      'X-MEXC-APIKEY': params.apiKey
    },
    urlParams: {
      timestamp,
      signature
    }
  };
}

export interface TwitterOAuth1aParams {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  method: string;
  /** Full URL including scheme and host, without query string */
  baseUrl: string;
  /** Override for deterministic tests */
  nonce?: string;
  timestamp?: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * OAuth 1.0a signing for Twitter/X API.
 *
 * Builds the signature base string per RFC 5849:
 *   METHOD&percent_encode(base_url)&percent_encode(sorted_params)
 *
 * JSON request bodies are NOT included in the signature (only
 * application/x-www-form-urlencoded params would be, per spec).
 */
export function signTwitterOAuth1a(params: TwitterOAuth1aParams): SigningResult {
  const nonce = params.nonce || randomBytes(16).toString('hex');
  const timestamp = params.timestamp || Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: params.accessToken,
    oauth_version: '1.0',
  };

  // Sort parameters alphabetically and build the parameter string
  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');

  const signatureBaseString = [
    params.method.toUpperCase(),
    percentEncode(params.baseUrl),
    percentEncode(paramString),
  ].join('&');

  const signingKey = percentEncode(params.consumerSecret) + '&' + percentEncode(params.accessTokenSecret);

  const signature = createHmac('sha1', signingKey)
    .update(signatureBaseString)
    .digest('base64');

  // Build the Authorization header value
  const authParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const headerValue = 'OAuth ' + Object.keys(authParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(authParams[k])}"`)
    .join(', ');

  return {
    headers: {
      'Authorization': headerValue,
    },
  };
}

export interface AwsSigV4Params {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  method: string;
  /** Full URL including scheme, host, path, and query string */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  sessionToken?: string;
  /** ISO 8601 basic format override for tests (e.g. "20260309T145000Z") */
  timestamp?: string;
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * AWS Signature Version 4 signing.
 *
 * Implements the full SigV4 algorithm:
 * 1. Create canonical request (method, URI, query, headers, payload hash)
 * 2. Create string to sign (algorithm, timestamp, credential scope, canonical request hash)
 * 3. Derive signing key via HMAC chain (date -> region -> service -> aws4_request)
 * 4. Compute signature and build Authorization header
 */
export function signAwsSigV4(params: AwsSigV4Params): SigningResult {
  const method = params.method.toUpperCase();
  const parsed = new URL(params.url);
  const body = params.body || '';

  // Timestamp
  const now = params.timestamp
    ? params.timestamp
    : new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = now.slice(0, 8); // YYYYMMDD

  // Canonical URI (must be URI-encoded, "/" stays)
  const canonicalUri = parsed.pathname || '/';

  // Canonical query string: sort params by key then value
  const sortedParams = [...parsed.searchParams.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // Headers to sign — always include host and x-amz-date
  const headersToSign: Record<string, string> = {};
  if (params.headers) {
    for (const [k, v] of Object.entries(params.headers)) {
      headersToSign[k.toLowerCase().trim()] = v.trim();
    }
  }
  headersToSign['host'] = parsed.host;
  headersToSign['x-amz-date'] = now;

  const payloadHash = sha256(body);
  headersToSign['x-amz-content-sha256'] = payloadHash;

  if (params.sessionToken) {
    headersToSign['x-amz-security-token'] = params.sessionToken;
  }

  const signedHeaderKeys = Object.keys(headersToSign).sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map(k => `${k}:${headersToSign[k]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    now,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // Derive signing key
  const kDate = hmacSha256('AWS4' + params.secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, 'aws4_request');

  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resultHeaders: Record<string, string> = {
    'Authorization': authHeader,
    'X-Amz-Date': now,
    'X-Amz-Content-Sha256': payloadHash,
  };

  if (params.sessionToken) {
    resultHeaders['X-Amz-Security-Token'] = params.sessionToken;
  }

  return { headers: resultHeaders };
}

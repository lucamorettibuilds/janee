import { createHash } from 'crypto';
import { URL } from 'url';
import {
  describe,
  expect,
  it,
} from 'vitest';

import { buildAuthHeaders } from './auth';
import type { ServiceConfig } from './mcp-server';

describe('buildAuthHeaders — oauth1a-twitter', () => {
  const service: ServiceConfig = {
    baseUrl: 'https://api.x.com',
    auth: {
      type: 'oauth1a-twitter',
      consumerKey: 'my-consumer-key',
      consumerSecret: 'my-consumer-secret',
      accessToken: 'my-access-token',
      accessTokenSecret: 'my-access-token-secret',
    },
  };

  it('should produce an OAuth Authorization header for POST /2/tweets', async () => {
    const result = await buildAuthHeaders('twitter', service, {
      method: 'POST',
      targetUrl: new URL('https://api.x.com/2/tweets'),
      body: '{"text":"hello"}',
    });

    expect(result.headers['Authorization']).toBeDefined();
    expect(result.headers['Authorization']).toMatch(/^OAuth /);
    expect(result.headers['Authorization']).toContain('oauth_consumer_key="my-consumer-key"');
    expect(result.headers['Authorization']).toContain('oauth_token="my-access-token"');
    expect(result.headers['Authorization']).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(result.headers['Authorization']).toContain('oauth_signature=');
    expect(result.urlParams).toBeUndefined();
  });

  it('should produce an OAuth header for GET /2/users/me', async () => {
    const result = await buildAuthHeaders('twitter', service, {
      method: 'GET',
      targetUrl: new URL('https://api.x.com/2/users/me'),
    });

    expect(result.headers['Authorization']).toMatch(/^OAuth /);
    expect(result.headers['Authorization']).toContain('oauth_consumer_key="my-consumer-key"');
  });

  it('should not include query params in the base URL for signing', async () => {
    const result = await buildAuthHeaders('twitter', service, {
      method: 'GET',
      targetUrl: new URL('https://api.x.com/2/users/me?user.fields=name,description'),
    });

    expect(result.headers['Authorization']).toMatch(/^OAuth /);
    // Query params should not appear in the OAuth header params
    expect(result.headers['Authorization']).not.toContain('user.fields');
  });
});

describe('buildAuthHeaders — aws-sigv4', () => {
  const service: ServiceConfig = {
    baseUrl: 'https://email.us-west-2.amazonaws.com',
    auth: {
      type: 'aws-sigv4',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-west-2',
      awsService: 'ses',
    },
  };

  it('should produce AWS SigV4 Authorization header for POST', async () => {
    const body = 'Action=ListIdentities&Version=2010-12-01';
    const result = await buildAuthHeaders('aws-ses', service, {
      method: 'POST',
      targetUrl: new URL('https://email.us-west-2.amazonaws.com/'),
      body,
    });

    expect(result.headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(result.headers['Authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE/');
    expect(result.headers['Authorization']).toContain('/us-west-2/ses/aws4_request');
    expect(result.headers['X-Amz-Date']).toBeDefined();
    expect(result.headers['X-Amz-Content-Sha256']).toBe(createHash('sha256').update(body).digest('hex'));
    expect(result.urlParams).toBeUndefined();
  });

  it('should produce AWS SigV4 for GET with query params', async () => {
    const result = await buildAuthHeaders('aws-s3', {
      ...service,
      baseUrl: 'https://s3.us-west-2.amazonaws.com',
      auth: { ...service.auth, awsService: 's3' },
    }, {
      method: 'GET',
      targetUrl: new URL('https://s3.us-west-2.amazonaws.com/mybucket?list-type=2'),
    });

    expect(result.headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(result.headers['Authorization']).toContain('/s3/aws4_request');
  });

  it('should include session token when present', async () => {
    const result = await buildAuthHeaders('aws-ses', {
      ...service,
      auth: { ...service.auth, sessionToken: 'FwoGZXIvYXdzEBY' },
    }, {
      method: 'GET',
      targetUrl: new URL('https://email.us-west-2.amazonaws.com/'),
    });

    expect(result.headers['X-Amz-Security-Token']).toBe('FwoGZXIvYXdzEBY');
  });
});

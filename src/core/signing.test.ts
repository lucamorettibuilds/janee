/**
 * Tests for HMAC signing implementations
 */

import { describe, it, expect } from 'vitest';
import { signBybit, signOKX, signMEXC } from './signing';
import { createHmac } from 'crypto';

describe('signBybit', () => {
  const apiKey = 'test-api-key';
  const apiSecret = 'test-api-secret';
  const timestamp = '1700000000000';
  const recvWindow = '5000';

  it('should sign GET request with query string', () => {
    const result = signBybit({
      apiKey,
      apiSecret,
      method: 'GET',
      queryString: 'symbol=BTCUSDT&category=spot',
      timestamp,
      recvWindow
    });

    // Verify headers are set
    expect(result.headers['X-BAPI-API-KEY']).toBe(apiKey);
    expect(result.headers['X-BAPI-TIMESTAMP']).toBe(timestamp);
    expect(result.headers['X-BAPI-RECV-WINDOW']).toBe(recvWindow);
    expect(result.headers['X-BAPI-SIGN']).toBeDefined();

    // Verify signature is correct (GET uses query string)
    const expectedPayload = timestamp + apiKey + recvWindow + 'symbol=BTCUSDT&category=spot';
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).toBe(expectedSig);
  });

  it('should sign POST request with body (not query string)', () => {
    const body = '{"symbol":"BTCUSDT","side":"Buy","orderType":"Limit","qty":"0.01","price":"50000"}';
    
    const result = signBybit({
      apiKey,
      apiSecret,
      method: 'POST',
      queryString: 'should=be-ignored',
      body,
      timestamp,
      recvWindow
    });

    // Verify signature uses body, not query string
    const expectedPayload = timestamp + apiKey + recvWindow + body;
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).toBe(expectedSig);

    // Verify it does NOT use query string
    const wrongPayload = timestamp + apiKey + recvWindow + 'should=be-ignored';
    const wrongSig = createHmac('sha256', apiSecret).update(wrongPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).not.toBe(wrongSig);
  });

  it('should sign PUT request with body', () => {
    const body = '{"orderId":"12345"}';
    
    const result = signBybit({
      apiKey,
      apiSecret,
      method: 'PUT',
      queryString: '',
      body,
      timestamp,
      recvWindow
    });

    const expectedPayload = timestamp + apiKey + recvWindow + body;
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).toBe(expectedSig);
  });

  it('should sign DELETE request with query string', () => {
    const result = signBybit({
      apiKey,
      apiSecret,
      method: 'DELETE',
      queryString: 'orderId=12345',
      timestamp,
      recvWindow
    });

    const expectedPayload = timestamp + apiKey + recvWindow + 'orderId=12345';
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).toBe(expectedSig);
  });

  it('should handle POST with empty body', () => {
    const result = signBybit({
      apiKey,
      apiSecret,
      method: 'POST',
      queryString: 'some=param',
      body: '',
      timestamp,
      recvWindow
    });

    // Empty body should still be used for POST
    const expectedPayload = timestamp + apiKey + recvWindow + '';
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.headers['X-BAPI-SIGN']).toBe(expectedSig);
  });

  it('should handle case-insensitive method', () => {
    const body = '{"test":true}';
    
    const resultLower = signBybit({
      apiKey,
      apiSecret,
      method: 'post',
      queryString: '',
      body,
      timestamp,
      recvWindow
    });

    const resultUpper = signBybit({
      apiKey,
      apiSecret,
      method: 'POST',
      queryString: '',
      body,
      timestamp,
      recvWindow
    });

    expect(resultLower.headers['X-BAPI-SIGN']).toBe(resultUpper.headers['X-BAPI-SIGN']);
  });
});

describe('signOKX', () => {
  const apiKey = 'okx-api-key';
  const apiSecret = 'okx-api-secret';
  const passphrase = 'my-passphrase';
  const timestamp = '2024-01-15T10:30:00.000Z';

  it('should sign GET request', () => {
    const result = signOKX({
      apiKey,
      apiSecret,
      passphrase,
      method: 'GET',
      requestPath: '/api/v5/account/balance',
      timestamp
    });

    expect(result.headers['OK-ACCESS-KEY']).toBe(apiKey);
    expect(result.headers['OK-ACCESS-TIMESTAMP']).toBe(timestamp);
    expect(result.headers['OK-ACCESS-PASSPHRASE']).toBe(passphrase);

    // Verify signature (base64 encoded)
    const expectedPayload = timestamp + 'GET' + '/api/v5/account/balance' + '';
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('base64');
    expect(result.headers['OK-ACCESS-SIGN']).toBe(expectedSig);
  });

  it('should sign POST request with body', () => {
    const body = '{"instId":"BTC-USDT","tdMode":"cash"}';
    
    const result = signOKX({
      apiKey,
      apiSecret,
      passphrase,
      method: 'POST',
      requestPath: '/api/v5/trade/order',
      body,
      timestamp
    });

    // OKX always includes body in signature
    const expectedPayload = timestamp + 'POST' + '/api/v5/trade/order' + body;
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('base64');
    expect(result.headers['OK-ACCESS-SIGN']).toBe(expectedSig);
  });

  it('should include query params in requestPath', () => {
    const result = signOKX({
      apiKey,
      apiSecret,
      passphrase,
      method: 'GET',
      requestPath: '/api/v5/market/ticker?instId=BTC-USDT',
      timestamp
    });

    const expectedPayload = timestamp + 'GET' + '/api/v5/market/ticker?instId=BTC-USDT' + '';
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('base64');
    expect(result.headers['OK-ACCESS-SIGN']).toBe(expectedSig);
  });
});

describe('signMEXC', () => {
  const apiKey = 'mexc-api-key';
  const apiSecret = 'mexc-api-secret';
  const timestamp = '1700000000000';

  it('should sign request and return URL params', () => {
    const result = signMEXC({
      apiKey,
      apiSecret,
      queryString: 'symbol=BTCUSDT',
      timestamp
    });

    expect(result.headers['X-MEXC-APIKEY']).toBe(apiKey);
    expect(result.urlParams).toBeDefined();
    expect(result.urlParams?.timestamp).toBe(timestamp);
    expect(result.urlParams?.signature).toBeDefined();

    // Verify signature
    const expectedPayload = 'symbol=BTCUSDT&timestamp=' + timestamp;
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.urlParams?.signature).toBe(expectedSig);
  });

  it('should handle empty query string', () => {
    const result = signMEXC({
      apiKey,
      apiSecret,
      queryString: '',
      timestamp
    });

    const expectedPayload = 'timestamp=' + timestamp;
    const expectedSig = createHmac('sha256', apiSecret).update(expectedPayload).digest('hex');
    expect(result.urlParams?.signature).toBe(expectedSig);
  });
});

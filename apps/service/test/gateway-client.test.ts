import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, hexToKey, type EncryptedEnvelope } from '@secretary/shared-crypto';
import type { CompleteRequest, CompleteResponse } from '@secretary/llm-protocol';
import { ENVELOPE_CONTENT_TYPE } from '@secretary/llm-protocol';
import { UpstreamError } from '@secretary/shared-types';
import { createGatewayClient } from '../server/llm/GatewayClient.js';

const PAYLOAD_KEY = 'a'.repeat(64);
const API_KEY = 'b'.repeat(64);

/** A fake gateway that decrypts the request and returns an encrypted canned completion. */
function startFakeGateway(onApiKey: (k: string | undefined) => void): Promise<{ url: string; server: Server }> {
  const key = hexToKey(PAYLOAD_KEY);
  const server = createServer((req, res) => {
    onApiKey(req.headers['x-api-key'] as string | undefined);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const envelope = JSON.parse(body) as EncryptedEnvelope;
      const decoded = decryptJson<CompleteRequest>(key, envelope);
      const response: CompleteResponse = {
        response: `echo:${decoded.prompt}`,
        model: decoded.model,
        tokens_in: 1,
        tokens_out: 2,
        duration_ms: 3,
      };
      res.writeHead(200, { 'content-type': ENVELOPE_CONTENT_TYPE });
      res.end(JSON.stringify(encryptJson(key, response)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let server: Server | undefined;
afterEach(() => server?.close());

describe('GatewayClient', () => {
  it('encrypts the request, sends X-API-Key, and decrypts the response', async () => {
    let seenApiKey: string | undefined;
    const started = await startFakeGateway((k) => (seenApiKey = k));
    server = started.server;

    const client = createGatewayClient({
      gatewayUrl: started.url,
      useCfHeaders: false,
      apiKey: API_KEY,
      payloadKey: PAYLOAD_KEY,
    });
    const out = await client.complete({ model: 'm', prompt: 'hello' });

    expect(out.response).toBe('echo:hello');
    expect(seenApiKey).toBe(API_KEY);
  });

  it('throws UpstreamError on a non-OK response and does not retry it', async () => {
    let calls = 0;
    const srv = createServer((_req, res) => {
      calls += 1;
      res.writeHead(500);
      res.end('nope');
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    server = srv;
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const client = createGatewayClient({
      gatewayUrl: `http://127.0.0.1:${port}`,
      useCfHeaders: false,
      apiKey: API_KEY,
      payloadKey: PAYLOAD_KEY,
    });
    await expect(client.complete({ model: 'm', prompt: 'x' })).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });

  it('retries once on a transient network failure then succeeds', async () => {
    const key = hexToKey(PAYLOAD_KEY);
    let n = 0;
    const srv = createServer((req, res) => {
      n += 1;
      if (n === 1) {
        req.socket.destroy(); // abruptly drop the first connection -> fetch rejects
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const decoded = decryptJson<CompleteRequest>(key, JSON.parse(body) as EncryptedEnvelope);
        const response: CompleteResponse = {
          response: `echo:${decoded.prompt}`,
          model: decoded.model,
          tokens_in: 1,
          tokens_out: 2,
          duration_ms: 3,
        };
        res.writeHead(200, { 'content-type': ENVELOPE_CONTENT_TYPE });
        res.end(JSON.stringify(encryptJson(key, response)));
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    server = srv;
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const client = createGatewayClient({
      gatewayUrl: `http://127.0.0.1:${port}`,
      useCfHeaders: false,
      apiKey: API_KEY,
      payloadKey: PAYLOAD_KEY,
    });
    const out = await client.complete({ model: 'm', prompt: 'again' });
    expect(out.response).toBe('echo:again');
    expect(n).toBe(2);
  });

  it('surfaces a typed UpstreamError when a 200 body is not a valid envelope', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ foo: 'bar' }));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    server = srv;
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const client = createGatewayClient({
      gatewayUrl: `http://127.0.0.1:${port}`,
      useCfHeaders: false,
      apiKey: API_KEY,
      payloadKey: PAYLOAD_KEY,
    });
    await expect(client.complete({ model: 'm', prompt: 'x' })).rejects.toBeInstanceOf(UpstreamError);
  });
});

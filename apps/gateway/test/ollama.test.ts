import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@secretary/shared-types';
import { createOllamaClient } from '../src/ollama.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Capture {
  url?: string;
  body?: Record<string, unknown>;
}

function captureFetch(response: () => Response): { fetchImpl: typeof fetch; capture: Capture } {
  const capture: Capture = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    capture.url = String(input);
    if (init?.body) {
      capture.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    return response();
  };
  return { fetchImpl, capture };
}

describe('OllamaClient.complete', () => {
  it('sends a /api/generate request and maps the response', async () => {
    const { fetchImpl, capture } = captureFetch(() =>
      jsonResponse({
        model: 'qwen',
        response: 'hi',
        done: true,
        prompt_eval_count: 12,
        eval_count: 34,
        total_duration: 5_000_000_000,
      }),
    );
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    const result = await client.complete({ model: 'qwen', prompt: 'hello', temperature: 0.5 });

    expect(capture.url).toBe('http://test/api/generate');
    expect(capture.body).toMatchObject({
      model: 'qwen',
      prompt: 'hello',
      stream: false,
      keep_alive: '0',
      options: { temperature: 0.5 },
    });
    expect(result).toEqual({
      response: 'hi',
      model: 'qwen',
      tokens_in: 12,
      tokens_out: 34,
      duration_ms: 5_000,
    });
  });

  it('passes format: json when requested', async () => {
    const { fetchImpl, capture } = captureFetch(() =>
      jsonResponse({ model: 'qwen', response: '{}', done: true }),
    );
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    await client.complete({ model: 'qwen', prompt: 'p', format: 'json' });
    expect(capture.body?.format).toBe('json');
  });

  it('passes a JSON schema when provided', async () => {
    const { fetchImpl, capture } = captureFetch(() =>
      jsonResponse({ model: 'qwen', response: '{}', done: true }),
    );
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    const schema = { type: 'object', properties: { x: { type: 'number' } } };
    await client.complete({ model: 'qwen', prompt: 'p', format: 'json', jsonSchema: schema });
    expect(capture.body?.format).toEqual(schema);
  });

  it('wraps non-OK responses in UpstreamError', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    await expect(client.complete({ model: 'qwen', prompt: 'p' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('wraps fetch failures in UpstreamError', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    await expect(client.complete({ model: 'qwen', prompt: 'p' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe('OllamaClient.modelInfo', () => {
  it('returns the default model when it is loaded', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ models: [{ name: 'qwen' }, { name: 'llama' }] });
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    expect(await client.modelInfo()).toBe('qwen');
  });

  it('falls back to the first model when default is missing', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ models: [{ name: 'llama' }] });
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    expect(await client.modelInfo()).toBe('llama');
  });

  it('returns null when fetch fails', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('down');
    };
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    expect(await client.modelInfo()).toBeNull();
  });

  it('returns null on non-OK response', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 });
    const client = createOllamaClient({
      baseUrl: 'http://test',
      defaultModel: 'qwen',
      defaultKeepAlive: '0',
      fetchImpl,
    });
    expect(await client.modelInfo()).toBeNull();
  });
});

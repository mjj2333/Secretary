import { UpstreamError } from '@secretary/shared-types';

interface OllamaGenerateRequest {
  model: string;
  system?: string;
  prompt: string;
  stream: false;
  format?: 'json' | object;
  options?: { temperature?: number; num_predict?: number };
  keep_alive?: string | number;
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

export interface CompleteParams {
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  format?: 'json';
  jsonSchema?: object;
  keepAlive?: string | number;
}

export interface CompleteResult {
  response: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
}

export interface OllamaClient {
  complete(params: CompleteParams): Promise<CompleteResult>;
  modelInfo(): Promise<string | null>;
}

export interface OllamaClientOptions {
  baseUrl: string;
  defaultModel: string;
  defaultKeepAlive: string | number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOllamaClient(opts: OllamaClientOptions): OllamaClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    async complete(params: CompleteParams): Promise<CompleteResult> {
      const body: OllamaGenerateRequest = {
        model: params.model,
        prompt: params.prompt,
        stream: false,
        keep_alive: params.keepAlive ?? opts.defaultKeepAlive,
      };
      if (params.system !== undefined) {
        body.system = params.system;
      }
      if (params.format === 'json') {
        body.format = params.jsonSchema ?? 'json';
      }
      if (params.temperature !== undefined || params.maxTokens !== undefined) {
        body.options = {};
        if (params.temperature !== undefined) body.options.temperature = params.temperature;
        if (params.maxTokens !== undefined) body.options.num_predict = params.maxTokens;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new UpstreamError(
            'ollama_timeout',
            `Ollama did not respond within ${timeoutMs}ms`,
            504,
          );
        }
        throw new UpstreamError(
          'ollama_unreachable',
          `Ollama request failed: ${(err as Error).message}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new UpstreamError(
          'ollama_error',
          `Ollama returned ${res.status}: ${detail.slice(0, 200)}`,
          502,
        );
      }

      const data = (await res.json()) as OllamaGenerateResponse;
      return {
        response: data.response,
        model: data.model,
        tokens_in: data.prompt_eval_count ?? 0,
        tokens_out: data.eval_count ?? 0,
        duration_ms: data.total_duration ? Math.round(data.total_duration / 1_000_000) : 0,
      };
    },

    async modelInfo(): Promise<string | null> {
      try {
        const res = await fetchImpl(`${baseUrl}/api/tags`, { method: 'GET' });
        if (!res.ok) return null;
        const data = (await res.json()) as OllamaTagsResponse;
        const names = data.models?.map((m) => m.name) ?? [];
        if (names.includes(opts.defaultModel)) return opts.defaultModel;
        return names[0] ?? null;
      } catch {
        return null;
      }
    },
  };
}

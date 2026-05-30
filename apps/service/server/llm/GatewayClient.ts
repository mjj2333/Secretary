import { CryptoError, decryptJson, encryptJson, hexToKey } from '@secretary/shared-crypto';
import {
  ENVELOPE_CONTENT_TYPE,
  completeResponseSchema,
  encryptedEnvelopeSchema,
  type CompleteRequest,
  type CompleteResponse,
} from '@secretary/llm-protocol';
import { DecryptionError, UpstreamError } from '@secretary/shared-types';

export interface GatewayClientOptions {
  gatewayUrl: string;
  useCfHeaders: boolean;
  apiKey: string;
  /** 64-char hex payload encryption key. */
  payloadKey: string;
  cfClientId?: string;
  cfClientSecret?: string;
}

export interface GatewayClient {
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const key = hexToKey(opts.payloadKey);
  const url = `${opts.gatewayUrl.replace(/\/$/, '')}/v1/complete`;

  const headers: Record<string, string> = {
    'content-type': ENVELOPE_CONTENT_TYPE,
    accept: ENVELOPE_CONTENT_TYPE,
    'x-api-key': opts.apiKey,
  };
  if (opts.useCfHeaders && opts.cfClientId && opts.cfClientSecret) {
    headers['CF-Access-Client-Id'] = opts.cfClientId;
    headers['CF-Access-Client-Secret'] = opts.cfClientSecret;
  }

  /** Performs the network POST. Retried exactly once on a transient (network) failure. */
  async function send(body: string): Promise<Response> {
    try {
      return await fetch(url, { method: 'POST', headers, body });
    } catch {
      // One retry on transient network failure (DNS, connection reset, etc.).
      return fetch(url, { method: 'POST', headers, body });
    }
  }

  return {
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const body = JSON.stringify(encryptJson(key, req));
      const res = await send(body);

      if (!res.ok) {
        throw new UpstreamError('gateway_error', `Gateway returned ${res.status}`, 502);
      }

      // Everything past a received 200 is deterministic — never retried, always
      // surfaced as a typed SecretaryError.
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        throw new UpstreamError('gateway_bad_response', 'Gateway returned a non-JSON body', 502);
      }

      const envelope = encryptedEnvelopeSchema.safeParse(raw);
      if (!envelope.success) {
        throw new UpstreamError('gateway_bad_response', 'Gateway returned a malformed envelope', 502);
      }

      let decoded: unknown;
      try {
        decoded = decryptJson<unknown>(key, envelope.data);
      } catch (err) {
        throw new DecryptionError(
          err instanceof CryptoError ? err.message : 'Gateway payload decryption failed',
        );
      }

      const parsed = completeResponseSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new UpstreamError('gateway_bad_response', 'Gateway returned a malformed completion', 502);
      }
      return parsed.data;
    },
  };
}

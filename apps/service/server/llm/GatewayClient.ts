import {
  decryptJson,
  encryptJson,
  hexToKey,
  type EncryptedEnvelope,
} from '@secretary/shared-crypto';
import {
  ENVELOPE_CONTENT_TYPE,
  completeResponseSchema,
  type CompleteRequest,
  type CompleteResponse,
} from '@secretary/llm-protocol';
import { UpstreamError } from '@secretary/shared-types';

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

  async function post(req: CompleteRequest): Promise<CompleteResponse> {
    const body = JSON.stringify(encryptJson(key, req));
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      throw new UpstreamError('gateway_error', `Gateway returned ${res.status}`, 502);
    }
    const envelope = (await res.json()) as EncryptedEnvelope;
    const decoded = decryptJson<unknown>(key, envelope);
    return completeResponseSchema.parse(decoded);
  }

  return {
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      try {
        return await post(req);
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        // One retry on transient network/parse failure.
        return post(req);
      }
    },
  };
}

/* eslint-disable no-console */
// Manual end-to-end test against a deployed (or local) gateway.
//
// Usage:
//   GATEWAY_URL=https://llm.example.com \
//   GATEWAY_API_KEY=<hex> \
//   PAYLOAD_ENCRYPTION_KEY=<hex> \
//   CF_ACCESS_CLIENT_ID=<id> \
//   CF_ACCESS_CLIENT_SECRET=<secret> \
//   pnpm --filter @secretary/gateway manual:round-trip "Say hi in five words"

import { decryptJson, encryptJson, hexToKey } from '@secretary/shared-crypto';
import { ENVELOPE_CONTENT_TYPE, type CompleteResponse } from '@secretary/llm-protocol';

const url = required('GATEWAY_URL');
const apiKey = required('GATEWAY_API_KEY');
const encryptionKey = hexToKey(required('PAYLOAD_ENCRYPTION_KEY'));
const cfId = process.env.CF_ACCESS_CLIENT_ID;
const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const prompt = process.argv[2] ?? 'Say hi in five words.';
const model = process.env.MODEL ?? 'qwen2.5:14b-instruct-q5_K_M';

async function main(): Promise<void> {
  const requestPayload = { model, prompt, temperature: 0.5, max_tokens: 200 };
  const envelope = encryptJson(encryptionKey, requestPayload);

  const headers: Record<string, string> = {
    'content-type': ENVELOPE_CONTENT_TYPE,
    'x-api-key': apiKey,
  };
  if (cfId && cfSecret) {
    headers['CF-Access-Client-Id'] = cfId;
    headers['CF-Access-Client-Secret'] = cfSecret;
  }

  const res = await fetch(`${url.replace(/\/$/, '')}/v1/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const responseEnvelope = (await res.json()) as { ciphertext: string; nonce: string };
  const decoded = decryptJson<CompleteResponse>(encryptionKey, responseEnvelope);

  console.log('---');
  console.log(decoded.response);
  console.log('---');
  console.log(
    `model=${decoded.model} tokens_in=${decoded.tokens_in} tokens_out=${decoded.tokens_out} ollama_duration_ms=${decoded.duration_ms}`,
  );
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

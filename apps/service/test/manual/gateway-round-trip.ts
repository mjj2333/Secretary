import { KeychainStore } from '../../server/auth/KeychainStore.js';
import { createGatewayClient } from '../../server/llm/GatewayClient.js';

const store = new KeychainStore();
const client = createGatewayClient({
  gatewayUrl: 'http://localhost:47823',
  useCfHeaders: false,
  apiKey: store.get('app.gateway-api-key') ?? '',
  payloadKey: store.get('app.payload-key') ?? '',
});
const out = await client.complete({
  model: 'qwen2.5:14b-instruct-q5_K_M',
  prompt: 'Say hi in 3 words.',
});
console.log(out);

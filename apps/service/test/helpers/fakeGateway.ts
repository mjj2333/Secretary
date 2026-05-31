import type { CompleteRequest, CompleteResponse } from '@secretary/llm-protocol';
import type { GatewayClient } from '../../server/llm/GatewayClient.js';

/** A GatewayClient that returns scripted `response` strings in order, recording each request. */
export class FakeGateway implements GatewayClient {
  readonly requests: CompleteRequest[] = [];
  private readonly responses: string[];
  private index = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? '';
    this.index += 1;
    return { response, model: req.model, tokens_in: 1, tokens_out: 1, duration_ms: 1 };
  }
}

/** A GatewayClient that always throws — for the transport-error path. */
export class ThrowingGateway implements GatewayClient {
  async complete(): Promise<CompleteResponse> {
    throw new Error('gateway down');
  }
}

import { z } from 'zod';

export const ENVELOPE_CONTENT_TYPE = 'application/cf-encrypted+json';

export const encryptedEnvelopeSchema = z.object({
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
});
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const completeRequestSchema = z.object({
  model: z.string().min(1),
  system: z.string().optional(),
  prompt: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  format: z.literal('json').optional(),
  json_schema: z.record(z.unknown()).optional(),
});
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const completeResponseSchema = z.object({
  response: z.string(),
  model: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});
export type CompleteResponse = z.infer<typeof completeResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  model_loaded: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

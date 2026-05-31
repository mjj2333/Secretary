import { z } from 'zod';
import type { ClassificationResult } from '@secretary/shared-types';

const INTENTS = [
  'inquiry',
  'booking_request',
  'scheduling',
  'chitchat',
  'question',
  'complaint',
  'other',
] as const;
const CATEGORIES = [
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
] as const;
const URGENCIES = ['low', 'normal', 'high'] as const;

/** Coerce any value to a member of `vals`, falling back to `fallback` (small models drift). */
function lenient<T extends readonly string[]>(vals: T, fallback: T[number]): z.ZodType<T[number]> {
  return z
    .any()
    .transform((v) => ((vals as readonly string[]).includes(v) ? v : fallback)) as z.ZodType<
    T[number]
  >;
}

export const classificationResultSchema = z.object({
  intent: lenient(INTENTS, 'other'),
  category_suggestion: lenient(CATEGORIES, 'unknown'),
  urgency: lenient(URGENCIES, 'normal'),
  // The decisive field — must be present and boolean-ish (accepts true/"true"/1 from
  // small/quantized models), else we treat the parse as failed. Case-sensitive by design (JSON booleans are lowercase).
  requires_response: z
    .union([z.boolean(), z.string(), z.number()])
    .transform((v) => v === true || v === 'true' || v === 1),
  summary: z
    .string()
    .optional()
    .transform((s) => (s ?? '').slice(0, 140)),
});

/** JSON schema passed to the gateway (advisory; we always re-validate with zod). */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    category_suggestion: { type: 'string', enum: [...CATEGORIES] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    requires_response: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['intent', 'category_suggestion', 'urgency', 'requires_response', 'summary'],
} as const;

export const STRICT_JSON_PREAMBLE =
  'You MUST respond with a single valid JSON object and nothing else. No markdown, no code fences, no commentary, no trailing text.';

/** Best-effort parse of a model completion into a ClassificationResult. Returns null on failure. */
export function parseClassification(raw: string): ClassificationResult | null {
  const candidate = extractJson(raw);
  if (candidate === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  const parsed = classificationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pulls a JSON object string out of a completion: strips fences, else grabs the first {...}. */
function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (fenced.startsWith('{')) return fenced;
  const match = fenced.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

import { describe, expect, it } from 'vitest';
import { parseClassification } from '../server/agent/classificationSchema.js';

describe('parseClassification', () => {
  it('parses a clean JSON object', () => {
    const r = parseClassification(
      '{"intent":"booking_request","category_suggestion":"client_new","urgency":"high","requires_response":true,"summary":"Wants to book a shoot"}',
    );
    expect(r).toEqual({
      intent: 'booking_request',
      category_suggestion: 'client_new',
      urgency: 'high',
      requires_response: true,
      summary: 'Wants to book a shoot',
    });
  });

  it('strips ```json fences', () => {
    const r = parseClassification(
      '```json\n{"intent":"question","category_suggestion":"unknown","urgency":"normal","requires_response":true,"summary":"A question"}\n```',
    );
    expect(r?.intent).toBe('question');
  });

  it('extracts the JSON object when wrapped in prose', () => {
    const r = parseClassification(
      'Sure! Here is the result: {"requires_response":false,"summary":"FYI"} Hope that helps.',
    );
    expect(r?.requires_response).toBe(false);
  });

  it('coerces stringy booleans and unknown enum values to safe defaults', () => {
    const r = parseClassification(
      '{"intent":"weird","category_suggestion":"nonsense","urgency":"URGENT","requires_response":"true","summary":"x"}',
    );
    expect(r).toEqual({
      intent: 'other',
      category_suggestion: 'unknown',
      urgency: 'normal',
      requires_response: true,
      summary: 'x',
    });
  });

  it('treats integer 1 as true and "false"/0 as false', () => {
    expect(parseClassification('{"requires_response":1,"summary":"x"}')?.requires_response).toBe(
      true,
    );
    expect(parseClassification('{"requires_response":0,"summary":"x"}')?.requires_response).toBe(
      false,
    );
    expect(
      parseClassification('{"requires_response":"false","summary":"x"}')?.requires_response,
    ).toBe(false);
  });

  it('clamps summary to 140 chars and defaults a missing summary to empty', () => {
    const long = 'a'.repeat(200);
    const r = parseClassification(`{"requires_response":true,"summary":"${long}"}`);
    expect(r?.summary).toHaveLength(140);
    const r2 = parseClassification('{"requires_response":true}');
    expect(r2?.summary).toBe('');
  });

  it('returns null when requires_response is missing or the body is garbage', () => {
    expect(parseClassification('{"summary":"no decision"}')).toBeNull();
    expect(parseClassification('not json at all')).toBeNull();
  });
});

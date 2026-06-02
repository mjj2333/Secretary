import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from './encoding.js';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to bytes', () => {
    // "hello" in base64url is "aGVsbG8" (no padding)
    const out = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
  });
  it('handles - and _ (url-safe) chars', () => {
    // bytes [251, 255] → base64 "+/8=" → base64url "-_8"
    const out = urlBase64ToUint8Array('-_8');
    expect(Array.from(out)).toEqual([251, 255]);
  });
});

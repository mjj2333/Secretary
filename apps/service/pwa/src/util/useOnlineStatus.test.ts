import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useOnlineStatus } from './useOnlineStatus.js';

describe('useOnlineStatus', () => {
  it('reflects offline/online events', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(navigator.onLine);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});

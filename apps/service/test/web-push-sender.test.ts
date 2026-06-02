import { describe, expect, it } from 'vitest';
import { WebPushSender } from '../server/push/WebPushSender.js';

function deps(
  now: Date,
  subs = [{ endpoint: 'https://push/1', keys_p256dh: 'p', keys_auth: 'a' }],
) {
  const sent: { endpoint: string; payload: string }[] = [];
  const deleted: string[] = [];
  return {
    sent,
    deleted,
    sender: new WebPushSender({
      publicKey: 'PUB',
      subscriptions: {
        list: () => subs,
        deleteByEndpoint: (e: string) => {
          deleted.push(e);
        },
      } as never,
      threads: {
        get: (id: string) => ({
          id,
          subject_normalized: 'Reschedule',
          participants: '["jane@x.com"]',
        }),
      } as never,
      messages: {
        latestInboundForThread: () => ({ from_address: 'jane@x.com', from_name: 'Jane' }),
      } as never,
      contacts: { findByEmail: () => ({ display_name: 'Jane Doe' }) } as never,
      settings: {
        get: (k: string) => (k === 'notifications.quiet_hours_start' ? '22:00' : '08:00'),
      } as never,
      client: {
        send: async (t: { endpoint: string }, p: string) => {
          sent.push({ endpoint: t.endpoint, payload: p });
        },
      },
      now: () => now,
    }),
  };
}

describe('WebPushSender.notifyDraftReady', () => {
  it('sends "New draft ready for <sender>" to each subscription outside quiet hours', async () => {
    const d = deps(new Date(2026, 0, 1, 12, 0)); // noon, not quiet
    await d.sender.notifyDraftReady('t1');
    expect(d.sent).toHaveLength(1);
    const payload = JSON.parse(d.sent[0]!.payload);
    expect(payload.title).toBe('New draft ready for Jane Doe');
    expect(payload.data.url).toBe('/threads/t1');
  });

  it('suppresses the push during quiet hours', async () => {
    const d = deps(new Date(2026, 0, 1, 23, 0)); // 23:00, quiet
    await d.sender.notifyDraftReady('t1');
    expect(d.sent).toHaveLength(0);
  });

  it('prunes a subscription that returns 410 Gone', async () => {
    const deleted: string[] = [];
    const sender = new WebPushSender({
      publicKey: 'PUB',
      subscriptions: {
        list: () => [{ endpoint: 'https://push/gone', keys_p256dh: 'p', keys_auth: 'a' }],
        deleteByEndpoint: (e: string) => deleted.push(e),
      } as never,
      threads: { get: () => ({ id: 't1', subject_normalized: 's', participants: '[]' }) } as never,
      messages: { latestInboundForThread: () => undefined } as never,
      contacts: { findByEmail: () => undefined } as never,
      settings: { get: () => '22:00' } as never,
      client: {
        send: async () => {
          const e = new Error('gone') as Error & { statusCode: number };
          e.statusCode = 410;
          throw e;
        },
      },
      now: () => new Date(2026, 0, 1, 12, 0),
    });
    await sender.notifyDraftReady('t1');
    expect(deleted).toEqual(['https://push/gone']);
  });
});

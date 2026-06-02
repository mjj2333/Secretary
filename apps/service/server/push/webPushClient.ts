import webpush from 'web-push';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Thin seam over web-push so the sender is unit-testable. Throws an Error carrying `statusCode` on failure. */
export interface WebPushClient {
  send(target: PushTarget, payload: string): Promise<void>;
}

export const realWebPushClient: WebPushClient = {
  async send(target, payload) {
    await webpush.sendNotification({ endpoint: target.endpoint, keys: target.keys }, payload);
  },
};

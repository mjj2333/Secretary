import type { PushService } from '../api/push.js';
import type { WebPushClient } from './webPushClient.js';
import type { PushSubscriptionRepository } from '../db/repositories/PushSubscriptionRepository.js';
import type { ThreadsRepository } from '../db/repositories/ThreadsRepository.js';
import type { MessagesRepository } from '../db/repositories/MessagesRepository.js';
import type { ContactsRepository } from '../db/repositories/ContactsRepository.js';
import type { SettingsRepository } from '../db/repositories/SettingsRepository.js';
import { resolveSenderName } from '../api/views.js';
import { isQuietHours } from '../agent/quietHours.js';

export interface WebPushSenderDeps {
  publicKey: string;
  subscriptions: Pick<PushSubscriptionRepository, 'list' | 'deleteByEndpoint'>;
  threads: Pick<ThreadsRepository, 'get'>;
  messages: MessagesRepository;
  contacts: ContactsRepository;
  settings: Pick<SettingsRepository, 'get'>;
  client: WebPushClient;
  now: () => Date;
}

interface Payload {
  title: string;
  body: string;
  data: { url: string };
}

export class WebPushSender implements PushService {
  readonly publicKey: string;
  constructor(private readonly deps: WebPushSenderDeps) {
    this.publicKey = deps.publicKey;
  }

  private quiet(): boolean {
    const start = String(this.deps.settings.get('notifications.quiet_hours_start') ?? '22:00');
    const end = String(this.deps.settings.get('notifications.quiet_hours_end') ?? '08:00');
    return isQuietHours(this.deps.now(), start, end);
  }

  /** Best-effort fan-out; never throws (it runs off an event). */
  private async broadcast(payload: Payload): Promise<number> {
    let sent = 0;
    for (const sub of this.deps.subscriptions.list()) {
      try {
        await this.deps.client.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
          JSON.stringify(payload),
        );
        sent += 1;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.deps.subscriptions.deleteByEndpoint(sub.endpoint);
        // else: transient — skip (no payload/body logged).
      }
    }
    return sent;
  }

  async notifyDraftReady(threadId: string): Promise<void> {
    try {
      if (this.quiet()) return;
      const thread = this.deps.threads.get(threadId);
      if (!thread) return;
      const senderName = resolveSenderName(thread, this.deps.messages, this.deps.contacts);
      await this.broadcast({
        title: `New draft ready for ${senderName}`,
        body: thread.subject_normalized ?? '',
        data: { url: `/threads/${threadId}` },
      });
    } catch {
      /* never throw from an event handler */
    }
  }

  async sendTest(): Promise<{ sent: number }> {
    const sent = await this.broadcast({
      title: 'Secretary test',
      body: 'Push is working.',
      data: { url: '/needs-attention' },
    });
    return { sent };
  }
}

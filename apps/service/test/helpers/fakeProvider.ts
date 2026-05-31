import type { RawMessage, SendInput } from '@secretary/shared-types';
import type { EmailProvider, SyncResult } from '../../server/providers/ProviderInterface.js';

/** In-memory EmailProvider for unit-testing the SyncManager + routes without real IMAP. */
export class FakeEmailProvider implements EmailProvider {
  private connected = false;
  private onChange: (() => void) | null = null;
  private incremental: RawMessage[] = [];
  private sendCount = 0;

  constructor(
    public readonly accountId: string,
    private readonly fullMessages: RawMessage[] = [],
  ) {}

  setIncremental(messages: RawMessage[]): void {
    this.incremental = messages;
  }

  emitChange(): void {
    this.onChange?.();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async syncFull(_sinceUnixMs: number): Promise<RawMessage[]> {
    return this.fullMessages;
  }

  async syncIncremental(): Promise<SyncResult> {
    return { newMessages: this.incremental, updatedMessages: [], nextSyncState: { lastUid: 1 } };
  }

  async startWatching(onChange: () => void): Promise<void> {
    this.onChange = onChange;
  }

  async stopWatching(): Promise<void> {
    this.onChange = null;
  }

  async sendMessage(_input: SendInput): Promise<{ providerMessageId: string }> {
    this.sendCount += 1;
    return { providerMessageId: `fake-${this.sendCount}` };
  }

  async markRead(): Promise<void> {}

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

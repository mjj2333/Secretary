import type { EmailProvider } from './ProviderInterface.js';

/** Holds the live EmailProvider instance per account. */
export class ProviderRegistry {
  private readonly byAccount = new Map<string, EmailProvider>();

  set(provider: EmailProvider): void {
    this.byAccount.set(provider.accountId, provider);
  }

  get(accountId: string): EmailProvider | undefined {
    return this.byAccount.get(accountId);
  }

  remove(accountId: string): void {
    this.byAccount.delete(accountId);
  }

  all(): EmailProvider[] {
    return [...this.byAccount.values()];
  }
}

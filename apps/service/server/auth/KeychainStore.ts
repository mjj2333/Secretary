import { Entry } from '@napi-rs/keyring';
import type { SecretStore } from './SecretStore.js';

const SERVICE_NAME = 'secretary';

/**
 * SecretStore backed by the OS keychain via @napi-rs/keyring.
 * Windows Credential Manager / macOS Keychain are selected transparently by the library.
 * `key` is the account name under the single "secretary" service, e.g. "app.db-key".
 *
 * API note: in @napi-rs/keyring v1.x, Entry.getPassword() returns string | null
 * (null when absent, rather than throwing), and deletePassword() returns boolean.
 * The try/catch guards from the original plan are therefore unnecessary but harmless
 * for getPassword(); they are retained in delete() in case of unexpected errors.
 */
export class KeychainStore implements SecretStore {
  private entry(key: string): Entry {
    return new Entry(SERVICE_NAME, key);
  }

  get(key: string): string | null {
    return this.entry(key).getPassword();
  }

  set(key: string, value: string): void {
    this.entry(key).setPassword(value);
  }

  delete(key: string): void {
    try {
      this.entry(key).deletePassword();
    } catch {
      /* already absent */
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }
}

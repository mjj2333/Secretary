/** Abstraction over OS secret storage. Consumers depend on this, not the keychain directly. */
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
}

/** In-memory store for tests and headless dev runs. */
export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

import webpush from 'web-push';
import type { SecretStore } from '../auth/SecretStore.js';

export const VAPID_SUBJECT = 'mailto:secretary@localhost';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Returns the stored VAPID keypair, generating + persisting one on first call. Idempotent. */
export function ensureVapidKeys(store: SecretStore): VapidKeys {
  const pub = store.get('app.vapid-public-key');
  const priv = store.get('app.vapid-private-key');
  if (pub && priv) return { publicKey: pub, privateKey: priv };
  const keys = webpush.generateVAPIDKeys();
  store.set('app.vapid-public-key', keys.publicKey);
  store.set('app.vapid-private-key', keys.privateKey);
  return keys;
}

/** Configures the global web-push VAPID details. Call once at startup when keys exist. */
export function configureWebPush(keys: VapidKeys): void {
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
}

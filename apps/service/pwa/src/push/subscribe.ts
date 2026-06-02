import { apiFetch } from '../api/client.js';
import { urlBase64ToUint8Array } from './encoding.js';

export type EnableResult = 'subscribed' | 'denied' | 'unsupported';

/** Request notification permission and register a push subscription with the service. */
export async function enablePush(): Promise<EnableResult> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return 'unsupported';
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await apiFetch<{ publicKey: string }>('/push/vapid-public-key');
  // Copy into a fresh ArrayBuffer-backed view: lib.dom's BufferSource wants
  // Uint8Array<ArrayBuffer>, while encoding returns the wider Uint8Array<ArrayBufferLike>.
  const applicationServerKey = new Uint8Array(urlBase64ToUint8Array(publicKey));
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await apiFetch('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      userAgent: navigator.userAgent,
    }),
  });
  return 'subscribed';
}

export async function sendTestPush(): Promise<number> {
  const res = await apiFetch<{ sent: number }>('/push/test', { method: 'POST', body: '{}' });
  return res.sent;
}

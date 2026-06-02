/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { BackgroundSyncPlugin } from 'workbox-background-sync';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback to the precached shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// Offline send-queue: queue POST /api/v1/drafts/:id/send and replay on reconnect.
registerRoute(
  ({ url, request }) =>
    request.method === 'POST' && /\/api\/v1\/drafts\/[^/]+\/send$/.test(url.pathname),
  new NetworkOnly({
    plugins: [new BackgroundSyncPlugin('send-queue', { maxRetentionTime: 24 * 60 })],
  }),
  'POST',
);

self.addEventListener('push', (event: PushEvent) => {
  let data: { title?: string; body?: string; data?: { url?: string } } = {};
  try {
    data = event.data ? (event.data.json() as typeof data) : {};
  } catch {
    data = {};
  }
  const title = data.title ?? 'Secretary';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body ?? '',
      tag: 'secretary',
      icon: '/icon.svg',
      data: data.data ?? { url: '/needs-attention' },
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string })?.url ?? '/needs-attention';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all.find((c) => 'focus' in c) as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        await existing.navigate(url);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

self.skipWaiting();
self.addEventListener('activate', () => self.clients.claim());

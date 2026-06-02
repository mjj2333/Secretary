import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { BottomNav } from './BottomNav.js';
import { useOnlineStatus } from '../util/useOnlineStatus.js';
import { getLastSync, subscribeLastSync } from '../util/syncStatus.js';
import { formatTimeAgo } from '../util/timeAgo.js';

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const online = useOnlineStatus();
  const lastSync = useSyncExternalStore(subscribeLastSync, getLastSync);
  return (
    <div className="mx-auto min-h-screen max-w-[720px] bg-white text-slate-900">
      <header className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">
        Secretary
      </header>
      {!online ? (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-800">
          Offline{lastSync ? ` — last synced ${formatTimeAgo(lastSync)}` : ''}
        </div>
      ) : null}
      <main className="px-4 pb-20 pt-3">{children}</main>
      <BottomNav />
    </div>
  );
}

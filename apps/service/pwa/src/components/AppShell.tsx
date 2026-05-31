import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav.js';

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mx-auto min-h-screen max-w-[720px] bg-white text-slate-900">
      <header className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">
        Secretary
      </header>
      <main className="px-4 pb-20 pt-3">{children}</main>
      <BottomNav />
    </div>
  );
}

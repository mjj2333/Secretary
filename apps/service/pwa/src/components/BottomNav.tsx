import { Link, useLocation } from 'wouter';

const ITEMS: { href: string; label: string }[] = [
  { href: '/needs-attention', label: 'Attention' },
  { href: '/followups', label: 'Follow-ups' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/settings', label: 'Settings' },
];

export function BottomNav(): JSX.Element {
  const [location] = useLocation();
  return (
    <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-[720px] justify-around border-t border-slate-200 bg-white">
      {ITEMS.map((it) => {
        const active = location.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-[44px] flex-1 items-center justify-center py-2 text-sm ${
              active ? 'font-semibold text-slate-900' : 'text-slate-500'
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

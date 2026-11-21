import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useHeadingFocus, usePageTitle } from '../lib/page';

/** Frame of every signed-out screen: wordmark, one serif heading, one column of content. */
export function AuthLayout({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  usePageTitle(title);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  return (
    <div className="min-h-dvh">
      <header className="border-rule border-b" style={{ padding: '14px var(--gutter)' }}>
        <Link to="/login" className="font-serif text-lg font-semibold tracking-tight">
          Akiba <span lang="ja">秋葉</span>
        </Link>
      </header>
      <main id="main" className="mx-auto w-full max-w-md" style={{ padding: '48px var(--gutter)' }}>
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-serif text-2xl font-semibold tracking-tight outline-none"
        >
          {title}
        </h1>
        {intro !== undefined && <p className="text-mute mt-2 text-base">{intro}</p>}
        <div className="mt-8 grid gap-6">{children}</div>
        {footer !== undefined && (
          <footer className="border-rule mt-10 border-t pt-6 text-sm">{footer}</footer>
        )}
      </main>
    </div>
  );
}

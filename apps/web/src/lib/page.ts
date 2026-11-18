import { useEffect, useRef } from 'react';

/** Set the document title for a screen ("Log in · Akiba"); screen readers announce route changes by it. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Akiba`;
  }, [title]);
}

/**
 * Move focus to the screen's heading when a route renders, so keyboard and screen-reader users
 * start at the top of the new content instead of wherever the old page left them.
 */
export function useHeadingFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

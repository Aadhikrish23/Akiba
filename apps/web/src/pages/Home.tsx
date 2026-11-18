import { useAuth } from '../auth/AuthContext';
import { usePageTitle } from '../lib/page';

/** The signed-in landing screen. Continue watching and recommendations arrive with the library (T18). */
export function HomePage() {
  usePageTitle('Home');
  const { state } = useAuth();
  const name = state.status === 'signed-in' ? (state.user.displayName ?? 'there') : 'there';
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold tracking-tight">Welcome, {name}</h1>
      <p className="text-mute mt-2 max-w-prose">
        Your shelf is empty for now. Searching and adding titles is the next thing to arrive.
      </p>
    </>
  );
}

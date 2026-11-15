import { APP_NAME } from '@akiba/shared';
import { COLOR_SCHEMES, spacing } from '@akiba/ui-tokens';

/** Placeholder shell proving the workspace wiring; real screens arrive in T10. */
export function App() {
  return (
    <main className="mx-auto max-w-prose" style={{ padding: spacing(6) }}>
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
      <p>Workspace scaffold. Supported colour schemes: {COLOR_SCHEMES.join(', ')}.</p>
    </main>
  );
}

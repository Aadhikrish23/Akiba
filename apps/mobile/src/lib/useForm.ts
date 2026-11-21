import { describeError, type Described } from '@akiba/api-client';
import { useState } from 'react';

/** Shared plumbing of the forms: field errors, one top-level message, a busy flag. */
export function useForm() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Described | null>(null);
  return {
    busy,
    problem,
    fields: problem?.fields ?? {},
    fail: (fields: Record<string, string>, message = 'Check the highlighted fields.') => {
      setProblem({ message, fields });
    },
    run: async (action: () => Promise<void>) => {
      setBusy(true);
      setProblem(null);
      try {
        await action();
      } catch (error) {
        setProblem(describeError(error));
      } finally {
        setBusy(false);
      }
    },
  };
}

export type Form = ReturnType<typeof useForm>;

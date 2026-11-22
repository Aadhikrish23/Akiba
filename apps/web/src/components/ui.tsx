import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

/** Form controls (doc 08 §3): hairline borders, soft corners, the mint accent for the primary action. */

interface FieldProps extends Omit<ComponentPropsWithoutRef<'input'>, 'id'> {
  readonly label: string;
  /** Plain-language problem with this field; also read out by assistive technology. */
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
}

export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        {...input}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="border-rule bg-raised text-ink h-11 w-full rounded-md border px-3 text-base aria-[invalid=true]:border-danger"
      />
      {hint !== undefined && (
        <p id={hintId} className="text-mute text-sm">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="text-danger text-sm font-medium">
          {error}
        </p>
      )}
    </div>
  );
}

interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  readonly variant?: 'primary' | 'outline' | 'link';
  readonly busy?: boolean;
}

export function Button({
  variant = 'outline',
  busy = false,
  children,
  disabled,
  onClick,
  className,
  ...rest
}: ButtonProps) {
  const style =
    variant === 'primary'
      ? 'h-11 rounded-full px-5 bg-accent text-on-accent font-bold'
      : variant === 'outline'
        ? 'h-11 rounded-full px-5 border-[1.5px] border-rule text-ink hover:border-ink'
        : 'underline underline-offset-4';
  const base = 'text-base font-medium disabled:opacity-60 cursor-pointer';
  return (
    <button
      {...rest}
      // A busy button stays focusable (a `disabled` one drops keyboard focus mid-action); it just
      // ignores clicks until the work is done.
      disabled={disabled === true}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      className={`${base} ${style} ${className ?? ''}`}
    >
      {children}
    </button>
  );
}

/** A status message that is announced when it appears (`polite`) or interrupts (`alert`). */
export function Notice({
  tone = 'info',
  children,
  focusRef,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
  focusRef?: React.Ref<HTMLDivElement>;
}) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      role={role}
      className={`rounded-md border px-4 py-3 text-sm ${
        tone === 'error' ? 'border-danger text-ink' : 'border-rule text-ink'
      }`}
    >
      {children}
    </div>
  );
}

interface SelectProps extends Omit<ComponentPropsWithoutRef<'select'>, 'id'> {
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** The option meaning "no filter", shown first with an empty value. */
  readonly anyLabel: string;
}

/** A native select with a visible label: keyboard and screen-reader behaviour for free. */
export function Select({ label, options, anyLabel, ...select }: SelectProps) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        {...select}
        className="border-rule bg-raised text-ink h-11 w-full rounded-md border px-3 text-base disabled:opacity-60"
      >
        {anyLabel !== '' && <option value="">{anyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

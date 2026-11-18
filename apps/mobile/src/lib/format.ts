/** "Fri, 20 Nov, 23:00 JST": a moment in the reader's own time zone (their account setting). */
export function formatMoment(iso: string, zone: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: zone,
      timeZoneName: 'short',
    });
  } catch {
    // A zone this device does not know: say it in UTC rather than in the wrong time.
    return new Date(iso).toISOString();
  }
}

/** "20 Nov 2026" in the reader's time zone. */
export function formatDay(iso: string, zone: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: zone,
    });
  } catch {
    return iso.slice(0, 10);
  }
}

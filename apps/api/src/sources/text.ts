const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
};

/**
 * Source synopses arrive with markup (`<br>`, `<i>`) and entities. The catalog stores plain text,
 * and clients render it as text, so nothing from a source is ever treated as HTML.
 */
export function plainText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|#0?39);/g,
      (entity) => ENTITIES[entity] ?? entity,
    )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/** A trimmed string, or null when it is empty or not a string. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A finite integer, or null. */
export function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Only absolute http(s) URLs are kept: a cover URL from a source is rendered by clients. */
export function httpUrl(value: unknown): string | null {
  const text = cleanString(value);
  if (text === null) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

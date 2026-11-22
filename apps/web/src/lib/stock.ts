import { contrastRatio, hexTokens, ticketStock } from '@akiba/ui-tokens';

/** The ink printed on every ticket (the same in both colour schemes). */
const INK = hexTokens.dark['stub-ink'];
/** Text on a ticket must read at 4.5:1 (doc 08 §6), whatever colour the cover gave it. */
const MIN_CONTRAST = 4.5;

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const toHex = (rgb: readonly number[]): string =>
  `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** `hex` moved towards white by `amount` (0 to 1). */
function lighten(hex: string, amount: number): string {
  return toHex(channels(hex).map((channel) => channel + (255 - channel) * amount));
}

/**
 * The colour a title's ticket is printed on: the cover's own colour when the catalog has one,
 * lightened until the ink on it reads; otherwise one of the stock colours, chosen from the title
 * id so a title always gets the same ticket.
 */
export function stockFor(title: {
  readonly id: string;
  readonly coverColor?: string | null;
}): string {
  const own = title.coverColor;
  if (typeof own === 'string' && /^#[0-9a-f]{6}$/i.test(own)) {
    for (const amount of [0, 0.15, 0.3, 0.45]) {
      const candidate = amount === 0 ? own : lighten(own, amount);
      if (contrastRatio(INK, candidate) >= MIN_CONTRAST) return candidate;
    }
  }
  let hash = 0;
  for (const char of title.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ticketStock[hash % ticketStock.length] ?? '#e4a128';
}

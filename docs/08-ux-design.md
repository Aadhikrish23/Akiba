# UX Design — "Shelf" direction

**Version:** 1.0 · **Date:** 2026-11-15 · Approved by the product owner. Reference mockup: [`mockups/shelf.html`](mockups/shelf.html).

## 1. Concept
Akiba should feel like a personal shelf: cover art is the hero and chrome stays quiet. A compact list view (borrowed from the "Ledger" direction) supports fast tracking.

**Never:** generic AI look — purple/blue gradients, glassmorphism, uniform rounded cards with drop shadows, emoji or stock icons as design, neon "anime" clichés, centered hero with three feature boxes.

## 2. Design tokens (source of truth: `packages/ui-tokens`)
| Token | Light | Dark |
|---|---|---|
| `paper` (background) | `oklch(96.5% .012 85)` | `oklch(19% .012 60)` |
| `raised` | `oklch(99% .006 85)` | `oklch(23.5% .014 60)` |
| `ink` (text) | `oklch(22% .015 60)` | `oklch(93% .012 85)` |
| `mute` (secondary text) | `oklch(48% .02 70)` | `oklch(70% .02 80)` |
| `rule` (hairlines) | `oklch(88% .015 80)` | `oklch(31% .015 60)` |
| `accent` (vermilion) | `oklch(55% .19 33)` | `oklch(68% .17 38)` |
| `on-accent` | `oklch(98% .01 85)` | `oklch(18% .02 40)` |

Mobile/Electron receive the same values converted to sRGB hex by a build step.
- **Type:** titles/headings in a high-contrast serif (system serif stack in prototype; final webfont TBD, e.g. a licensed or open-source serif); UI in a neutral grotesque/system sans; **tabular numerals** for counts and episode numbers. Japanese text set with a proper CJK fallback.
- **Scale:** 11 / 13 / 15 / 18 / 24 / 32 px (rem-based).
- **Spacing:** 4-px base; gutters `clamp(16px, 4vw, 40px)`.
- **Radius:** 2 px (almost square). **Elevation:** none; separation by hairline rules.
- **Motion:** minimal; ≤150 ms; respect `prefers-reduced-motion`.
- **Theme:** follows system via `color-scheme` and `light-dark()`; a manual override lives only in Settings.

## 3. Components
| Component | Rules |
|---|---|
| **Poster card** | 2:3 cover; progress as a 4-px bar on the cover's bottom edge; title and meta below; whole card is one link via the title (stretched link) |
| **Continue card** | Small cover + title, big serif episode count (`16 / 28`), **+1 episode** button, airing indicator |
| **List row** | 44-px cover thumb, title, progress meter, count, score, **+1**; fixed column slots so rows align when +1 is absent |
| **Status tabs** | Text tabs with counts, active = ink + accent underline |
| **Segmented toggle** | Posters / List; native radio under the hood |
| **Section header** | Small-caps eyebrow, serif H2, hairline rule, optional right link |
| **Button** | Outline default (ink border), filled for primary; accent only for state (airing, progress, active) |
| **Inbox item** | Cover thumb, "Episode N of Title aired", relative time, unread dot in accent |

## 4. Screens
**Web / Desktop (sidebar nav ≥ 880 px; top nav below):** Home · Discover (search, browse, season chart) · Title detail · Franchise · Studio · Character · Library (grid/list, status tabs) · History · Inbox · Settings (profile, theme, title language, export, share link, delete account) · Auth screens · Shared list (public).
**Mobile (tab bar):** Home · Discover · Library · Inbox · Me. Title detail, franchise, studio, character, history and settings are pushed screens.

### Key flows
1. **Log an episode:** Home/Library/Title → `+1` → optimistic update → at final episode, inline prompt "Mark completed?".
2. **Add to library:** Title page → status picker (one tap, defaults to Planned/Watching).
3. **Rewatch:** Completed entry → "Rewatch" → new Run; history keeps both.
4. **Override episode total:** Title/entry → "Episode count looks wrong?" → edit → badge "Edited" with reset.
5. **Share:** Settings → Share → choose scope → copy link; revoke anytime.

## 5. States
Every list/screen defines: loading (skeleton matching layout, no spinners over content), empty (one sentence + one action, no illustrations required), error (what happened + retry), offline/stale (subtle "cached" label per NFR-REL-001).

## 6. Accessibility (WCAG 2.2 AA)
- Text contrast ≥ 4.5:1; UI/graphical ≥ 3:1 (verify accent on paper and on posters; progress bar has a track contrast).
- Full keyboard support; visible focus ring (2 px accent); focus drawn on the card, not the stretched link.
- Touch targets ≥ 44×44 px on mobile (the prototype's compact list is allowed ≥ 32 px on desktop pointer only).
- Status never conveyed by colour alone (text label or position accompanies it).
- Semantic HTML: card = `article`, one link per card; radios for toggles; labelled search.
- Reduced motion, dark/light parity, zoom to 200% without loss.

## 7. Responsive rules
Breakpoints 560 / 880 / 1200 px. Poster grid `auto-fill, minmax(150px, 1fr)`. Cards use container queries so they adapt to their own width. List mode hides meter and score on narrow widths.

## 8. Content and tone
Plain, specific, no exclamation clutter. Title display follows user setting (romaji default). Dates in the user's locale and time zone. Episode counts always tabular.

## 9. Assets
Cover art comes from source URLs (Q-06). Where absent, a typographic placeholder (colour block + title) is used — as in the mockup. Source attribution appears in the footer/About.

## 10. Prototype notes
The mockup demonstrates: tokens, light/dark, poster grid ↔ list toggle with no JS, +1 interaction, container queries, responsive nav. Real art, final webfont and Japanese typography still to be tuned in M2.

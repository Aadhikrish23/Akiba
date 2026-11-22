# UX Design — "Ticket Stub Night" direction

**Version:** 2.0 · **Date:** 2026-11-22 · Approved by the product owner. This replaces the 1.0 "Shelf" direction (cream paper, serif, vermilion). Reference mockups: [`mockups/desktop-redesign/`](mockups/desktop-redesign/index.html) (desktop and phone; open `home.html`). The old Shelf mockup stays in [`mockups/shelf.html`](mockups/shelf.html) for history.

## 1. Concept
Akiba is a cinema lobby at night, and every episode you watch is a punched ticket stub. A show you follow is a ticket printed in a colour taken from its cover; **+1** stamps it (観了), and the episode numeral gets heavier the further in you are. The calendar borrows the Japanese TV listing: times run past midnight (25:30 is 1:30 am) and a week is a timetable of your own shows. Cover art stays the hero; the interface around it is dark, ticket-coloured and has one mint accent that always means "press me".

**Never:** generic anime-site look (banner carousels, neon, sparkle), generic SaaS dashboard (metric tiles, card grids of the same size), cold and clinical. No gradient text, no coloured side stripes, no emoji as icons.

## 2. Design tokens (source of truth: `packages/ui-tokens`)
| Token | Light | Dark |
|---|---|---|
| `paper` (background) | `oklch(96.5% .012 85)` | `oklch(16% .035 265)` |
| `raised` | `oklch(99% .006 85)` | `oklch(20.5% .04 265)` |
| `raised-2` (selected, track) | `oklch(93% .012 85)` | `oklch(26% .045 265)` |
| `ink` (text) | `oklch(20% .04 265)` | `oklch(95% .012 90)` |
| `mute` (secondary text) | `oklch(44% .035 265)` | `oklch(74% .035 265)` |
| `rule` (hairlines) | `oklch(86% .015 85)` | `oklch(32% .045 265)` |
| `accent` (mint: "press me", focus) | `oklch(40% .1 165)` | `oklch(90% .15 165)` |
| `on-accent` | `oklch(97% .02 165)` | `oklch(20% .05 200)` |
| `danger` (errors, destructive) | `oklch(46% .18 28)` | `oklch(74% .15 25)` |
| `stub-ink` (ink on ticket stock) | `oklch(19% .04 265)` | `oklch(19% .04 265)` |

Mobile/Electron receive the same values converted to sRGB hex by a build step.
- **Ticket stock:** a ticket is printed on a colour taken from the title's cover (until the catalog supplies it, one of twelve warm stock colours chosen from the title id). `stub-ink` text on every stock colour is at least 4.5:1 (tested in `@akiba/ui-tokens`).
- **Type:** titles, day names and big numerals in **Big Shoulders Display** (condensed, variable weight); UI and Japanese text in **Zen Kaku Gothic New**; the ticket note in **Yomogi** (handwriting, one short note, never UI). Self-hosted, no font CDN. **Tabular numerals** for counts and episode numbers.
- **Scale:** 11 / 13 / 15 / 18 / 24 / 32 px (rem-based) for text; display sizes 40 / 56 / 84 px for ticket numerals and page titles, clamped down on narrow screens.
- **Spacing:** 4-px base; gutters `clamp(16px, 4vw, 40px)`.
- **Radius:** 6 px controls, 10 px tickets and posters, 14 px for the largest surfaces. **Elevation:** only a ticket lifts (a soft, offset drop shadow); everything else is separated by hairline rules.
- **Motion:** transitions ≤150 ms, plus one authored moment: the 観了 stamp that lands on +1 (about a second and a half, with the numeral thickening). All of it is off under `prefers-reduced-motion`.
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
**Web / Desktop (left rail ≥ 880 px; slim top bar and bottom tab bar below):** Home · Schedule (tonight as tickets; the week as a timetable in broadcast time, 25:30 = 1:30 am; a day agenda on a phone; `GET /library/schedule`) · Discover (search, browse, season chart) · Title detail · Franchise · Studio · Character · Library (grid/list, status tabs) · History · Inbox · Settings (profile, theme, title language, export, share link, delete account) · Auth screens · Shared list (public).
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

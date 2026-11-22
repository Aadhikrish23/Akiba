# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Anime enthusiasts who watch several series at once, week to week, and want one dedicated place for it. Starts as a personal-use product (the owner is user zero), designed to serve a broader audience. Desktop web is the primary surface (mobile app follows later and must share the same identity).

## Product Purpose
Akiba is an anime discovery, collection and tracking app: discover titles, keep a personal library, track episode progress and new releases, remember ratings/reviews/history, and explore franchises, studios, characters and seasons. Success = discovery usefulness, library-management efficiency, tracking accuracy, collection reliability, long-term engagement (doc 01).

## Positioning
Not a database and not a social network: an evolving personal anime universe that remembers your journey. Differentiators already built: airing inbox (episodes that aired for what you are Watching), franchise graphs with your status on every entry, +1 episode logging, private-by-default library with revocable share link, full export.

## Operating Context
Used at a desk (and later a phone) in short check-ins after episodes air and in longer sessions browsing the season chart or curating the library. Titles show romaji by default (user can switch to English). Cover art comes from AniList/Jikan source URLs; where absent, a typographic placeholder is used. No streaming, no video hosting.

## Capabilities and Constraints
Web screens that exist today: Home (continue + airing), Discover (search, season chart, genre browse), Title page (cast, studio, franchise, shelf panel), Franchise, Studio, Character, Library (grid/list, status tabs), History, Inbox, Settings (theme, language, adult toggle, export, share link, delete/restore), auth screens, public shared list. Light/dark follows system with manual override in Settings. Adult-rated titles hidden by default. Redesign must keep every existing function and the data model; it is a visual and experiential replacement.

## Brand Commitments
Name Akiba (秋葉), inside the Yume ecosystem. Previous "Shelf" look (cream paper, serif headings, vermilion accent, hairlines) is explicitly NOT binding: user asked to replace it fully. Do not look like a generic anime site (neon, purple gradients, clichés) or a generic SaaS dashboard (grey grid of rounded cards, stat tiles); do not feel cold or clinical: should feel loved, personal, a little playful.

## Evidence on Hand
Real cover art and metadata are available live from AniList (e.g. Shingeki no Kyojin) and recorded fixtures in apps/api. No testimonials, user counts or ratings of the product itself exist; do not invent them.

## Product Principles
1. The user's own anime life leads: resume, what aired, their collection, their history come before generic catalog browsing.
2. Cover art is the hero material; chrome serves it.
3. Logging an episode must take one gesture.
4. Personal and private by default; sharing is deliberate.
5. Warm, specific and characterful, never clinical.

## Accessibility & Inclusion
WCAG 2.2 AA (axe-verified in light and dark in CI). Keyboard complete, visible focus, status never by colour alone, reduced motion respected, Japanese text with proper CJK fallback.

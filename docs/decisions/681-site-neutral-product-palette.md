# 681 — The marketing site wears the product's neutral palette

- Status: accepted
- Date: 2026-10-20

## Context

On 2026-10-19 /live's frame moved off warm cream onto white and cool grey. Lane 01M5BEE19C made that
change because nick read /live in a pitch as "too silly/casual/game like" for something teams buy.
Only the office scene kept its warmth. The new palette lives on `.lc` in `packages/web/src/live/Live.css`.

The public site (musterd.io and its pages) and the Cloud console (app.musterd.io) stayed on the old
cream. Their tokens were `--ground #f7efe2` and `--text #2a2118`, with a mustard-50 band behind the hero
and mustard-100 rules. Headings used the Recursive Casual cut, which [ADR 477](477-web-type-recursive.md)
assigned to the display role. [ADR 037](037-web-surface-aesthetic.md) is what lets the site take a
different register from the product chrome.

On 2026-10-20 nick asked for musterd.io and its pages to match /live's more neutral look. He was shown
two mocks (https://claude.ai/artifact/1BgcPJ61LUPdywrt6XRZMn):

- A changed the palette only.
- B also set the site's headings in the linear cut.

He picked B.

## Problem

The site is the first thing a buyer sees. It now looks like a different, more playful product than
the one they open. /live's frame says "a tool your team runs on", and the site still says
"a cosy game". Three things carry the playful read:

- the cream grounds,
- the mustard-tinted hero band,
- the bouncy Casual headlines.

The site's dark-text contrast was also tuned against cream. That tuning has to be measured again on
the new grounds, not assumed.

## Decision

The site and the console take the product's neutral palette. Site headings take the linear cut.

- **Site tokens:** `:root[data-theme='light']` in `packages/web/src/styles/tokens.css` takes /live's
  frame values:

  | Token | Value |
  | --- | --- |
  | `--ground`, `--hero-ground`, `--surface-raised` | `#f4f5f7` |
  | `--ground-2`, `--surface-solid` | `#ffffff` |
  | `--hairline` | `rgba(17,24,39,.09)` |
  | `--hairline-strong` | `rgba(17,24,39,.18)` |
  | `--text` | `#15181e` |
  | `--text-dim` | `#3a404b` |
  | `--text-faint` | `#5c6370` |
  | `--accent-ink` | mustard-900 `#7a5a06` |

  The office scene's own tokens (`--sky` … `--muted`) are the scene's and do not change.
- **No mustard tint bands:** the hero sits on `--hero-ground`. Rules that used `--mustard-100` use
  `--hairline`. Mustard stays the one accent: buttons, links (as `--accent-ink`), marks and the logo.
- **Headings in the linear cut on the public pages:** `.site-page` and `.join` set
  `--font-display: var(--font-sans)` and tighten h1–h3 to `-0.015em`. This is scoped, not a change to
  the token's root value, because /live's member names and chyron labels (DOM and canvas) also read
  `--font-display` and keep the casual cut. That is ADR 477's display role, now held only inside
  the product's room.
- **The console:** `packages/console/assets/console.css` takes the same values. Its control edge is
  `#7f848e`, opaque, at ≥3:1 on both the ground and a field. The session notice is a white strip with
  the mustard mark. The h1 uses the linear cut.
- **ADR 037 still stands.** The site may still use motion, the office scene and depth. This ADR
  decides only its ground, ink and heading face.

## Consequences

- brand.md §3 and §7 say where the casual cut now lives: /live and the office, not the public site
  or the console.
- The fix ships in this same change for musterd.io/start, which wrapped each step's copy one word per
  line in production. The `::before` step number auto-placed the copy into the 2.5rem number column.
- Merging does not deploy the site; miley deploys musterd.io ([ADR 308](308-public-site-deploy-authorization.md)).
  The console ships with its own release.
- To walk this back, revert the token block, the two `site.css` rules and the console's `:root`. No
  component reads a raw colour that changed.

## Observability & Evaluation

n/a: a visual change to the public site and the sign-in pages, not an agent-facing behaviour.

- **Traces:** none.
- **Eval:** the a11y contrast sweep over `/`, `/start`, `/watch` and `/docs` in CI, and before/after
  captures at 1440 and 390 attached to the PR.
- **Experiment:** none. The palette was chosen by nick from mocks, not by a measured conversion.

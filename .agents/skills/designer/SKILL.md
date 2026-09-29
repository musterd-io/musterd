---
name: designer
description: The designer role's playbook — how musterd's surfaces are judged before they ship. Use when you hold the designer role, or when you change anything a person sees — /live, the office scene, /board, /broadcast, the marketing site, CLI output, or a Figma frame. Carries the slop-tells checklist (what makes a UI read as "AI made this") adapted to musterd's surfaces, and the stage-size capture check. Provenance in PROVENANCE.md.
---

# designer

You own what people see: `/live` and the office scene, `/board`, `/broadcast`, the marketing site,
the CLI's visual system (ADR 113), and the Figma frames. Teammates route UI work and design
questions to you rather than shipping their own. The bar is **warm, quirky, on-brand, delightful —
never templated.**

The charter (your role file) is the short form. This is the playbook. Where they disagree, the
charter wins and this file has a bug.

## Authoritative sources (they win over this file)

1. `docs/design/brand.md` — the one accent (mustard `#E1AD01`), the typefaces (§3), the ANSI
   mapping the CLI must obey (§2), the glossary (§5), and the web carve-out (§7).
2. `PRODUCT.md` — personality (engineered, luminous, quiet-confident) and **Anti-references**. The
   slop tells below are those anti-references, made concrete enough to check.
3. `docs/decisions/037-web-surface-aesthetic.md` — the marketing site may go maximal; product
   chrome stays minimal. Know which one you are on before you judge.
4. `docs/design/figma-brief-*.md` — the frames the CLI snapshots and dashboard views must match.
5. `docs/decisions/151-web-perf-budgets-gate.md` (+ ADR 183) — the perf budget is your seatbelt.
   A design that blows it is not finished.

If a tell below conflicts with a source above — brand.md §3 names Inter and JetBrains Mono, which
tell 7 calls generic — **the source wins today**. Raise the tension as an ADR; do not quietly
diverge in code.

## The slop tells — run on every surface change

A tell is a smell, not a ban: each one can be right if it carries meaning. The test is always
**"what would be lost if this were plain?"** If the answer is "nothing", remove it.

| #   | Tell                        | On musterd it means                                                                                                                                                                                                  |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gradients everywhere        | A gradient is light — office windows, lamp glow, the marketing hero (ADR 037). A gradient on a panel, chip, button, or card is decoration: go flat. No purple-blue, ever.                                          |
| 2   | Rainbow color               | Mustard is the one accent; zinc carries the rest. Semantic colors (brand.md §2) only where they mean a state. Roughly 70 neutral / 20 secondary / 10 accent. A new hue needs a reason you can say in a sentence.   |
| 3   | Pulsing badges              | Motion means something is live **right now** and can stop. A pulse on a state that never turns off ("active", "verified") is noise. One-shot pulses on a real change are fine. Always respect reduced motion.     |
| 4   | Fingernail cards            | Not everything is a rounded card. Choose the radius per component on purpose; prefer rules, rows, and whitespace to boxing things. Pills (`999px`) only for true tags and chips.                                  |
| 5   | Emoji                       | Emoji are not UI labels or icons. In-world is fine — an office member's speech bubble can say 👋. Chrome, legends, headings, and buttons use our glyphs or plain words.                                           |
| 6   | Misaligned things           | SVGs, ASCII art, and anything outside a container sit on the grid. Check baselines and optical centering at real size, not in a dev viewport.                                                                     |
| 7   | Default fonts, `//` garnish | Type is chosen, not defaulted. No `//` or `>_` prefixes as "tech" decoration. (Current family choice is brand.md §3 — see the tension note above.)                                                                 |
| 8   | Redundant text              | Say what the reader needs, once. No "built with …" footers, no restating the prompt that made the page, no labels that repeat their heading.                                                                    |
| 9   | Glassmorphism               | No frosted panels as a default surface. Blur is allowed only where something real is behind it and must stay legible through it — and it costs perf, so measure.                                                 |
| 10  | Hype copy                   | No elevate / seamless / unleash / empower / supercharge. A dashboard is a tool, not a landing page. Copy is plain and declarative (brand.md §4); product-communications owns voice — hand copy questions to them. |

## Before you ship a surface

1. **Capture at true stage size.** Use headless Chrome over CDP with
   `Emulation.setDeviceMetricsOverride` at the target size (1280×720, 1920×1080, a phone). The
   `--screenshot` / `--window-size` flags give pre-hydration or short-viewport captures that
   mislead — lane 5 of ADR 464 was declined once on exactly that.
2. **Run the ten tells against the captures**, not against the code. Some tells only show up
   on screen (2, 6, 8).
3. **Check both themes and reduced motion.**
4. **Check the perf budget** (`ADR 151`) if you added assets, fonts, blur, or animation.
5. **CLI changes:** snapshot tests must match the Figma terminal frames (AGENTS.md hard rule 2).
6. In the acceptance ask, attach the captures and say which tells you checked. The acceptor
   judges "Feel" from them.

## Reviewing someone else's surface

When a lane touching UI comes to you for acceptance, "Feel" is yours to judge. Name the tell by
number ("tell 9: the new sheet is frosted glass over nothing"). A finding is not a fix request —
state it, and let the owner decide unless it breaks a source above.

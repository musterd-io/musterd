# Visual design, motion and the tells

Open for layout, type, color, motion, real-time views and command-line output, and to run the tells
on any change.

## 1. The tells: defaults nobody chose

A tell is a smell. Each one can be right when it carries meaning; the test is what would be lost if
it were plain. Run the catalog on captures: several only show on screen.

| Tell | What to do instead |
| --- | --- |
| Gradients as decoration (washes, gradient text, purple-to-blue) | A gradient is light or depth with a source. Emphasis comes from size and weight. |
| Many hues | One accent for meaning, neutrals for the rest (roughly 70 neutral, 20 secondary, 10 accent). A new hue needs a reason you can say in one sentence. |
| Pulsing or glowing badges | Motion means live and able to stop. A pulse on a state that never changes is noise. |
| Identical cards as the page structure; cards inside cards | Rows, rules and whitespace before boxes. Radius chosen per component; pills only for real tags. |
| Emoji or Unicode glyphs as icons | One drawn icon set, one stroke and weight. Emoji only inside the content's own world. |
| Misalignment | SVG, ASCII art and anything outside a container sits on the grid; check baselines and optical centering at real size. |
| Default type, or monospace as a "technical" costume | Type is chosen. Monospace for code, data and measurements only. |
| Template chrome: eyebrow labels over every heading, `01 / 02 / 03` markers, "A · B · C" meta strings, `//` or `>_` prefixes | Delete; the heading carries its own weight. Numbering only when the order is information. |
| Redundant text: labels that repeat headings, "built with" footers | Say it once. |
| Glass and blur over nothing | Blur only where something real is behind it, stays legible, and its cost is measured. |
| The hero-metric layout: big number, small label, accent | Show the thing itself when you can. |
| One identical entrance animation on every section | One authored moment, or none. |
| Hype copy (elevate, seamless, unleash, supercharge) | Hand words to whoever owns voice. |

Swapping one tell for the next safe default produces next year's tell. Fix the decision behind
the symptom. (Sources: "10 Tells of a Slop UI", cited; Impeccable's craft floor, Apache-2.0; Anthropic's
`frontend-design` skill, Apache-2.0; see `PROVENANCE.md`.)

## 2. Layout and type

- **Spacing from a scale**, tight within a group and generous between groups; more space above a
  heading than below it.
- **Measure**: body text 65–75 characters a line; headings balanced (`text-wrap: balance`).
- **A type scale with visible steps** in size and weight; one or two families, clearly different
  if two. Tabular numerals in columns of numbers.
- **Long and short content**: every container handles a very long name, an empty string and a
  short one (truncate, wrap or clamp on purpose).

## 3. Color

- **Color by role.** A ramp where each step has one job (background, hover, border, solid,
  text) keeps choices consistent. Radix's 12-step scales and Primer's muted/emphasis roles are
  models (`PROVENANCE.md`).
- **An accent that fails contrast** on a background is used there as a fill behind dark text, and
  a darker shade of the same hue carries text, icons and chart lines.
- **Meaning never rides on color alone**: pair it with a word, a glyph or a shape.

## 4. States

Every panel has empty, loading, error, partial and stale states, designed, with the copy for each.
Loading feedback follows response time: nothing under about a second, a skeleton for a full view
that takes up to ten, a progress indicator with an estimate beyond that (NN/g, cited).

## 5. Motion

- **Purpose.** Motion shows a change the user needs to notice, or continuity between two states.
  Motion nobody triggered is used sparingly, to draw attention once.
- **Tokens.** Durations and easings come from the team's tokens, chosen once and reused.
  Duration scales with distance travelled. (IBM Carbon publishes a reference set, Apache-2.0.)
- **Every message carried by motion has a static equivalent**, because reduced motion removes the
  motion and screen readers never saw it.
- **It can stop.** Honor `prefers-reduced-motion`; anything that moves or updates by itself for
  more than five seconds beside other content needs a pause (`references/accessibility.md`).
- **Cheap to run.** Animate `transform` and `opacity`; never `transition: all`; animations stay
  interruptible (Vercel's web interface guidelines, MIT).

## 6. Real-time and live views

There is little primary guidance written for this; these rules are a synthesis (sources in
`PROVENANCE.md`):

- Presence as a steady dot with a text label; never a perpetual pulse.
- A changed item gets a muted highlight that fades; it does not jump or flash.
- Bursts are batched ("4 new") instead of shifting the list under the reader's eye.
- Each panel shows its own loading, empty, error and stale state, and says how old its data is
  when that matters.
- The view can be paused, and resumes at the current state.

## 7. Command-line output

- Color with intent: one meaning per color, red sparingly, the most important line last.
- Color off when output is not a terminal, when `NO_COLOR` is set and not empty, when `TERM=dumb`,
  or with `--no-color`; no animation when output is not a terminal.
- Results to stdout, errors and logs to stderr; offer `--json` or `--plain` for machines.
- Every colored state also carries a word or glyph.

(The Command Line Interface Guidelines at clig.dev, CC BY-SA: cited and paraphrased only.)

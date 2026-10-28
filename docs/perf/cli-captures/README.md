# CLI terminal captures (lane 01M61VTVH62X4Q9VFKHVH05AB5)

Real output of `renderHelp` / `renderCommandHelp` / `renderBanner` at 40, 60 and 80 columns,
color off (NO_COLOR / non-TTY), generated from the built CLI. These are the verification
evidence for the terminal-accessibility lane: no line exceeds its requested width, and no
ANSI escapes leak into piped/no-color output.

- `help-{40,60,80}.txt` — the grouped overview.
- `help-{status,inbox,lane}-{40,80}.txt` — per-command detail.
- `help-piped.txt` — piped (non-TTY) output, 80 columns, no ANSI.
- `banner.txt` — the wordmark banner (`renderBanner`).

Color is off in every capture (picocolors auto-disables on a non-TTY stdout), matching the
`NO_COLOR`/pipe contract. Figma frame updates for the terminal brief are a separate
Figma-agent task; these captures are the source of truth for the rendered text.

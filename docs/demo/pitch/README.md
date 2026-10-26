# Pitch deck

The standing musterd pitch: 13 slides, about six minutes, for any event at any time. It began as the
Demo Day deck of 2026-10-09 (nick, 2026-10-13: "make it our standing pitch deck").
`../demo-day-2026-10-09/` keeps that day's deck as it was shown. Change this one, not that one.

| File | Is |
| --- | --- |
| `deck.html` | The deck, and its source. Edit it in the browser (below) |
| `script.md` | The spoken text, the source for every number, and the questions to expect |
| `counts.sh` | Prints slide 7's two counts from the team's database |
| `chain.sh` | Prints the chain behind ADR 665's table from the team's database: who signed off, who accepted, who asked, refusals, asks to people. Run by a person; re-read monthly |
| `build.sh` | Renders `musterd-pitch.pdf` without the browser, in the deck's own order. Needs Chrome |
| `avatar.jpg` | nick's headshot for the founder slide. Not committed (`.gitignore`); copy one in |

## Before an event

1. `./counts.sh`, then put the lane and ask counts on slide 7 and in `script.md` (page 7 and its
   sources row), and the writing share in `script.md` (page 8 and its sources row).
2. Re-check the answers in `script.md` that carry a date, and anything on slides 9 and 10 marked
   coming soon or next: if it shipped, the slide says so.
3. Slide 12's two asks fit an investor room. For another room, change them in `script.md`.
4. Slide 13 points the room at the Twitch stream. With a screen and network, open it there.
5. Export: press `D` in the served deck, or run `./build.sh [dir]`. If the organizers want their
   own file name, rename the PDF; do not put event names in this folder.

## Edit the deck in the browser

```bash
node docs/demo/pitch/serve.mjs     # then open http://localhost:4862/
```

| Key | Does |
| --- | --- |
| `E` | Edit mode: click any text and type |
| `M` | Move mode (inside edit mode): drag anything; double-click puts it back |
| `⌘S` | Save to `deck.html`; the diff is only what you changed |
| `D` | Save, then write `musterd-pitch.pdf` to `$PDF_OUT` (default `~/Downloads`) |
| `←` `→` | Slides |

`⌘P` in the browser also prints every slide to its own page. `editor.js` is the same editor as the
event decks'.

# Demo Day, 2026-10-09

Six-minute pitch to investors, founders and media. The organizers' upload folder is
`musterd_DemoDay` with four files; this folder holds the sources for them.

| Upload file | Source here |
| --- | --- |
| `BP_musterd.pdf` | `deck.html`: edit it in the browser (below), then press D or run `build.sh` |
| `Logo_musterd.png` | `docs/design/assets/chip.svg`, rendered at 2048 px with a transparent ground |
| `TeamInfo_musterd.docx` | `teaminfo.md`, built with `pandoc` |
| `Avatar_NickSanders.jpg` | nick's headshot; not committed |

`script.md` is the spoken text, the source for every number, and likely questions.

Rebuild the deck: `./build.sh ~/Downloads/musterd_DemoDay`.

## Edit the deck in the browser

```bash
node docs/demo/demo-day-2026-10-09/serve.mjs     # then open http://localhost:4861/
```

| Key | Does |
| --- | --- |
| `E` | Edit mode: click any text and type |
| `M` | Move mode (inside edit mode): drag anything; double-click puts it back |
| `⌘S` | Save to `deck.html`; the diff is only what you changed |
| `D` | Save, then write `BP_musterd.pdf` to `~/Downloads/musterd_DemoDay/` |
| `←` `→` | Slides |

`⌘P` in the browser also prints every slide to its own page. `./build.sh [dir]` renders the PDF from
the saved file without the browser. `editor.js` is the same editor as the Multiplayer AI deck.

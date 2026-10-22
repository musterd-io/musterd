# The README header

`readme-header.html` is **the source**; `docs/design/assets/readme-header.png` is a build artifact — never
hand-edit the PNG. Needs Chrome, the only dependency, not added to the repo:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --window-size=1280,320 \
  --screenshot="docs/design/assets/readme-header.png" \
  --virtual-time-budget=2000 \
  "file://$PWD/docs/brand/readme-header/readme-header.html"
```

Then open the PNG and look at it. The lockup is the mark (ADR 702) beside the word.

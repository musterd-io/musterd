# Phone remote for the Demo Day deck

One page that is the deck (on the laptop) or a phone controller (on the phone), joined by the artifact `room` capability.

## Build and publish

    python3 docs/demo/demo-day-2026-10-09/remote/build_remote.py

The script inlines the deck's fonts, logos and images into `dist/demo-remote.html` (about 800 KB) and adds the remote code. Publish that file as an Artifact with `capabilities: {"room": {}}`.

## Use

- **Laptop:** open the artifact link with `#deck` on the end. A laptop browser also picks the deck by itself.
- **Phone:** open the same link with nothing after it.
- The big gold buttons are the deck's own next and back, one reveal or one slide at a time, exactly like the arrow keys. The row above the chips moves the script cards. The `Deck` pill opens a sheet with all 15 slides to jump to.

## Rules

- Do not publish a new version during a talk: it reloads every open view and empties the room.
- `runofshow.html` is the phone script. Edit it here, rebuild, republish. Editing a published copy changes nothing in the remote.
- Tested on 2026-10-09 with a stand-in room in headless Chrome; the real two-device link worked once for nick.

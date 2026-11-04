# 797 — Member portraits reach the phone

- Status: accepted
- Date: 2026-11-03

## Context

On /live, the team panel shows each member as a small portrait. The portrait is cropped from that
member's rendered office figure (lane 01M6017Z38): `office-scene/portrait.ts` paints one idle frame
on a canvas in the browser and publishes it as a 64×64 PNG. The figure sheets and the painter live
only in the browser bundle.

The phone's Seats screen (ADR 791) shows each seat as a letter in a circle. nick, 2026-11-03:
"the musterd members should show their avatar pics like they do on the team panel on /live." He
chose this design (question `01M6JG42Q9`, option A) over painting the figures on the phone, which
would ship the figure art and a native drawing library in the app.

The phone reaches the daemon only through sealed relay deliveries (ADR 676). A sealed body's
ciphertext is capped at 64 KiB of base64url (`SealedBodyWireSchema.ct`), about 48 KB of plaintext.
A 64×64 portrait PNG is about 4–8 KB, so the roster cannot carry every seat's picture inline.

## Problem

The phone has no way to get a member's portrait, and the daemon has none to give it. Only a
browser can paint one.

## Decision

1. **/live hands each portrait to the daemon.** After `paintPortraits` paints a member, /live sends
   `PUT /teams/:slug/members/:name/portrait` with the PNG bytes (`content-type: image/png`). The
   daemon stores the PNG and answers `{digest}`. /live sends again only when the picture changes.
   That is when the paint key (`kind | color | dnd | sheets`) changes, or when the daemon does not
   have it yet. It never sends on every frame.
2. **Only a person's session may set one.** The caller authenticates as for any member route. A
   human or a full-scope observer (a person's hidden /live watch seat, ADR 064) may write. An agent
   seat and a `public` or `broadcast` observer are refused (`forbidden`). The writer is not limited
   to the member or an admin, because the uploader is almost never the subject: agents do not run
   /live, and the picture is derived, so every browser paints the same bytes from the same look.
   The body is parsed through `PortraitUploadSchema` (`@musterd/protocol`). The content-length is
   checked against `PORTRAIT_MAX_BYTES` (16 KiB, so a sealed portrait stays well inside the relay's 64 KiB frame) before the body is read. The bytes must carry the
   PNG signature and an IHDR of exactly 64×64. Each write is audited as `member.portrait`. The
   daemon never serves a portrait to a browser: the only reader is the phone, which gets it sealed.
3. **The daemon keeps portraits as a cache, not a store.** It writes them to files beside the
   database (`portraits/<team id>/<sha256>.png`) and keeps an index of member name → digest. There
   is no table, no migration and no sync row. A lost cache costs nothing: the next /live paint
   refills it. A member who leaves keeps no portrait in the roster, because the roster lists only
   standing seats.
4. **The roster names each seat's picture by digest.** `AppDelivery` `roster` seats gain an optional
   `portrait: string | null`, the first 16 hex characters of the PNG's sha256. The field is
   optional, so a phone built before this decision still parses the roster.
5. **The phone fetches a picture by ref and caches it by digest.** A new delivery kind, `portrait`,
   is `{v: 1, kind: 'portrait', team, binding, digest, png}`, where `png` is base64url. The phone
   fetches it through the relay with `ref` = `portrait-<digest>`, the same way it fetches a roster
   that was too big to push (ADR 676 §2). The daemon seals it to the paired phone. The phone keeps
   each PNG in memory for the life of the app, keyed by digest, so it fetches a picture once per
   launch until it changes. It adds no storage dependency.
6. **Until a picture arrives, the seat keeps its letter.** That covers a seat that has no portrait
   yet, a failed fetch, and an older daemon.

## Consequences

- The phone shows the same faces as /live, after /live has been open once since a look changed. On
  a team where nobody opens /live, the phone shows letters, as today.
- The roster grows by one short string per seat. A picture travels once per change, not once per
  roster.
- The phone gains no new dependency. React Native's `Image` shows a `data:` URI from the cached
  bytes.
- The daemon's disk holds about 8 KB per member. Nothing prunes stale digests. A team re-colouring
  every seat many times leaves orphans, and deleting the directory is safe.
- An authenticated person could upload a picture that is not the member's figure. It shows on the
  phone until the next /live paint replaces it. That is the same reach a person already has over
  a seat's hue (ADR 374), and agent seats cannot do it.

## Observability & Evaluation

- **Traces:** `member.portrait` audit rows carry the actor, the target member and the digest. A
  sealed `portrait` delivery is audited like every other app delivery (`auditSealed`, `fetched`).
- **Eval:** none. The change is visual and does not touch agent behaviour.
- **Experiment:** n/a — nick asked for this. Success is the Seats screen on a TestFlight build
  showing the faces /live shows, and he judges that.

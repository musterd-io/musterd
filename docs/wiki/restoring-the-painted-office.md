# Restoring the painted office

How to get the painted (vector) office back on `/live`, `/broadcast` and `/office-preview` now that the rendered office is the default. It covers one page load, everyone, and the time after the painters are deleted.

## Where things stand (2026-10-23)

- The rendered office has been the default since #3265 (2026-10-23, lane 01M5D8EJ40). The room, furniture, figures, dog and welcome wagon are pre-rendered art. Every painter is still in the code, so the painted office is one switch away.
- nick asked for a way back to stay available whatever happens to the code (2026-10-23).
- The tag **`office-painted-last`** marks the last `main` with every painter intact (`389aba10`, #3278). Nothing deletes that tag, so it stays a restore point after the painters go.

## One page load

Add `office=painted` to the URL: `http://localhost:4849/live?team=revive&office=painted`. It works on `/live`, `/broadcast` and `/office-preview` for as long as the painters are in the code. `renderedOfficeFromSearch` in `packages/web/src/live/office-scene/rendered/assets.ts` reads it.

- Falsify: open `/office-preview?office=painted`. A room drawn from the corner camera with WebP art (network panel: `office-art-*.webp` fetched) would mean the switch no longer works.

## Everyone, while the painters exist

In `rendered/assets.ts`, change `renderedOfficeFromSearch` to return `get('office') === 'rendered'`, and change its fallback to `false`. Then merge. That makes painted the default again, with `?office=rendered` as the opt-in. `/live` republishes about 60 s after the merge with no daemon restart. `/broadcast` picks it up the next time the stream relaunches, and musterd.io needs `deploy:site` (ADR 308). Revert #3265 instead only if you also want its figure composite cache gone; that cache only matters to the rendered office.

## After the painters are deleted

The deletion lands as one PR that says so in its title (lane 01M5D8EJ40, plan Task 19). Either way below works:

1. **Revert that PR** (`git revert <its squash sha>` on a branch, PR, merge). This brings the painters and `?office=painted` back at once. Rebase conflicts are likely if `render.ts`, `character.ts`, `skeleton.ts` or `iso.ts` changed since. Resolve them toward the painted code.
2. **Restore the files from the tag** if the revert is too tangled: `git checkout office-painted-last -- packages/web/src/live/office-scene/` on a branch from fresh `main`. Then re-apply whatever office changes landed after the tag (`git log office-painted-last..origin/main -- packages/web/src/live/office-scene/`).

Then flip the default as above. The painted scene needs no art files; it is all code.

- Falsify: `git ls-remote --tags origin office-painted-last` printing nothing would mean the restore point is gone.

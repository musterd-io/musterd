# 755 — Generated meshes for office props (Meshy)

- Status: accepted
- Date: 2026-10-28

## Context

The office art is pre-rendered from Blender, and until now every piece of it was built by a script
(`packages/web/art/office/scene.py`, `figure.py`): text that diffs, regenerates and reviews like code
(office realism spec 2026-10-20, ADR 151 for the bytes). That has served the room and the figures
well, but every prop is an evening of hand-modelling, and the props backlog is growing: desk
personality (a trophy, a plant that grows, mugs), the courier's parcel, a second dog, café clutter.

nick has a month of Meshy Pro (text and image to 3D, an API with an MCP server, .glb export, 1,000
credits). On 2026-10-28 one trial (lane `01M62KGRC2FVP51906GZWQMS57`) asked for a desk trophy as an
untextured preview: 20 seconds, 5 credits, a 57 KB .glb whose silhouette — curled handles, a knot on
the stem, a stepped base — beats what a script would reasonably build. nick: "that looks pretty
realistic … lets use meshy where we can".

## Problem

A generated mesh is a binary file, not a script, so it does not diff and cannot be regenerated
byte-for-byte; Meshy keeps its outputs only three days and the free month ends. Its textures are
realistic PBR, while the room is soft and matte, so a mesh dropped in as-is looks pasted on. And a
generated character or garment cannot join the figure, whose pieces are held out against one shared
body frame by frame.

## Decision

1. **Meshy is used for static props, never for the figure.** Furniture, desk items, the courier's
   parcel, animals that only stand or walk as one piece — yes. People, their clothes, hair and
   accessories stay scripted in `figure.py`.
2. **The mesh is the source and lives in the repo**, under `packages/web/art/office/meshes/<name>.glb`,
   with a sidecar `<name>.json` recording the prompt, the Meshy model and settings, the task id, the
   date and the credits spent. Only the untextured preview is kept (`mode: "preview"`), as a .glb.
   The sidecar is what makes a binary reviewable: a reviewer reads the prompt and the settings, not
   the bytes.
3. **The scene owns the look.** `scene.py` imports the .glb, scales it to its floor size, replaces
   every material with the room's own (`matte`, `wood`, `paint`, …) and smooth-shades it, exactly as
   a scripted prop would be dressed. Meshy's textures are never used.
4. **Nothing ships at runtime.** The .glb is an art input; the shipped asset is still the rendered
   WebP, counted against `officeArtBytes` like any other. Hard rule 6 is untouched (no runtime
   dependency); Meshy is an art tool, like Blender.
5. **The key stays off the record.** A seat reads it from `~/.config/musterd/meshy.key` (mode 600) at
   request time and never prints or commits it; the generator script lives with the art scripts.

## Consequences

- Props become a prompt and a few credits. The free month is roughly 200 previews; an asset already
  in the repo survives the subscription ending, because the mesh, not the service, is the source.
- Repo size grows by tens of KB per prop (the trial trophy is 57 KB at 3,000 polygons); a prop that
  needs more is a reviewer's question, read off the sidecar.
- A prop is no longer regenerable byte-for-byte: re-running its prompt makes a different mesh. A
  change to a generated prop is a new generation and a new sidecar, reviewed as a picture.
- The comparison still (Meshy trophy beside a script trophy, both in the room's materials) is the
  first evidence of fit; it is recorded on the trial lane when it renders.

## Observability & Evaluation

n/a — an art-pipeline choice for pre-rendered props; no agent-facing behaviour, traces or evals
change. The evidence that it works is visual (the comparison still) and the cost is recorded per
prop in its sidecar.

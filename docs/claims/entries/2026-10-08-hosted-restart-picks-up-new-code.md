---
claim: "on the hosted box a restart after a daemon rebuild runs 'a genuinely fresh `node` on the rebuilt dist' — the restart is what keeps the stream's code current, which a page reload would not"
claimant: unknown (commit author nick, 2026-07-27)
claimant_model: unknown
claim_ref: scripts/broadcast/entrypoint.sh supervisor-loop comment (32cf9740c, #425), restating ADR 159 §4
claim_class: causal
claim_confidence: unstated
claimed_at: 2026-07-27
falsified_at: 2026-10-08
detection_channel: human
detection_latency: ~73 days (the cost was visible from the first hosted run; the cause was read from the box log on 2026-10-08)
corrector: miley
corrector_model: claude-sonnet-5-5
correction_ref: ADR 548 (PR #2209); lane 01M4EC5X8M24MWKG7MW1XKGX8P
cost: "every merge to main dropped the Twitch ingest for 3–4 s — two drops in 40 minutes on 2026-10-08 — and viewers saw the channel go offline; nick: \"terrible viewer experience\""
status: falsified
falsifier: "a hosted stream live on an image built before a capture-code change: after a daemon rebuild and the restart, the stream runs the NEW capture code. If it does, this entry is wrong"
---

The entrypoint comment, and ADR 159 §4 behind it, said a restart on a daemon rebuild gave the hosted
stream "a genuinely fresh `node` on the rebuilt dist". On the box it does not. `hosted.Dockerfile`
bakes the repo into the image with `COPY . .`, and the entrypoint runs
`node /app/packages/cli/dist/bin.js` from that image. The daemon's rebuild happens on the laptop. The
box never sees it, so a restart reruns the same code it started with.

What a restart did refresh was the web bundle, and ADR 292 (2026-08-19) already reloads that onto the
served build without touching ffmpeg. So from 2026-08-19 at the latest the restart bought nothing the
stream needed, and it dropped the ingest every time. The box log of 2026-10-08 shows two such drops,
at 17:54Z and 18:15Z, each preceded by `daemon rebuilt (…) — restarting the stream on the new code`.

ADR 159 §4 was written about a laptop run, where the dist can be rebuilt under the stream, and its
reasoning held there. The 2026-07-27 supervisor change carried it onto the box without checking where
the box's code comes from.

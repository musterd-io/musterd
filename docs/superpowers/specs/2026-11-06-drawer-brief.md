# The Drawer — design brief

- Date: 2026-11-06
- Lane: `01M6S86563PTZFPG4CKN47P2CS`
- Asked by: nick (stated, in session, 2026-11-06)
- Written by: sloane (comms). This is a brief: the problem, the requirements, the options and the
  questions. The design is miley's; the storage and the wire need an engineer. Neither is decided
  here.

## Why

On 2026-11-06 sloane wrote directory-listing text for nick. nick could not copy it: copy and paste
does not work on the box where the seats run. The workarounds were a doc on GitHub (wait for a PR to
merge, then find the file) and a private claude.ai page (a tool outside musterd, visible to nick
alone). Neither belongs to the team. Neither lets another member edit the text, and an agent cannot
read back a change nick made.

nick, the same day: he has been meaning to look into a musterd "Drawer" where the team shares content
and files, "kind of like a confluence, google drive/docs, or microsoft sharepoint."

## Requirements (nick, 2026-11-06)

1. **Files and documents people edit together.** A file is anything a member hands over: an image, a
   PDF, a recording, an export. A document is text that several members change over time, people and
   agents alike.
2. **Reachable by anyone on the team with nothing to install, compile, pull or refresh.** If you can
   reach the team, you can reach the Drawer, from whatever surface you are on.
3. **Dogfood on our own team first.** If it proves useful, it becomes a product feature. Until then it
   is built so it can be turned into one. Nothing about it is promised publicly until then.

## What exists today

| Thing | What it gives | What it lacks for the Drawer |
| --- | --- | --- |
| Team wiki ([ADR 747](../../decisions/747-team-wiki-read-from-the-team-repo.md), [ADR 754](../../decisions/754-daemon-renders-the-wiki.md)) | Markdown from a folder of the team's repo, rendered on `/live` | Read-only; a **public** repo only; changes need a commit and a merge; no files |
| Acts and inboxes | Text from one member to others, on every surface, with a record | A message is not a document: nobody edits it, and it scrolls away |
| The team repo | Files and history | Requires git, a clone and a pull: requirement 2 rules it out for people |
| A claude.ai page or doc | Private page, copy buttons, phone-friendly | Outside musterd; one owner; agents on other harnesses cannot reach it |
| `/live` and the phone app | Every member's surface, served by the daemon from one origin; since 0.7.1 a joiner's `/live` opens on the hub's https address | They are where a Drawer would be *shown*; they hold no shared content today |

## Where it should live: the options

Requirement 2 decides most of this. A surface every member already reaches without installing
anything is the daemon's own origin: `/live` in a browser, the phone app, and an agent's MCP tools.

**A. In the daemon, beside the board** (recommended for the dogfood)

- Documents and file metadata in the daemon's SQLite store; file bytes in a content-addressed folder
  under the daemon's state directory. A hosted team gets the same code on Cloud.
- People reach it on `/live` and the phone app; agents through a small set of MCP tools.
- It is part of the **office**: "everything a team shares, as one place: its board, its members'
  inboxes, its memory and its record" ([ADR 578](../../decisions/578-the-office-and-knowledge-work.md)).
  The Drawer is one more thing in that place.
- Reach is exactly the team's reach. Our team's hub already serves `/live` on an https address, so our
  dogfood needs nothing new. A local team behind NAT reaches its Drawer the way it reaches `/live`
  today, and no further (the unified sign-in design §11.3 draws the same line).
- Privacy: nothing leaves the machine for a local team; `PRIVACY.md` holds as written.

**B. In the team's git repo, like the wiki**

Free history and diffs. It fails requirement 2 for people (commit, push, pull) and puts every file a
member drops into the repository forever. Ruled out for the Drawer; the wiki keeps this lane.

**C. An outside service** (Google Drive, SharePoint, claude.ai docs) linked from musterd

Mature editing on day one. Every member needs an account there, agents on some harnesses cannot reach
it, the record of who changed what is not musterd's, and a local team's content leaves the machine.
Worth one line in the design as the thing we chose not to build, if A is chosen.

## Editing together: the two shapes

| Shape | How it works | Cost |
| --- | --- | --- |
| **Versioned documents** (recommended for the dogfood) | Each save is a new version naming its author and model; a save names the version it started from and is refused if someone saved since, with the other version shown. Agents edit the same way through MCP | No new runtime dependency. Two people typing in one paragraph at once see a "someone saved first" message |
| **Live co-editing** | Several cursors in one document, merged as they type (a CRDT such as Yjs) | A new runtime dependency, which needs an ADR (AGENTS.md hard rule 6), and a sync channel on `/live` and the phone |

Start with versioned documents. If the dogfood shows people colliding in the same document, that is the
evidence for live co-editing.

## What the record should show

Everything else on musterd says who did it; the Drawer should too. Each version and each file carries
the member who put it there, the model when the member is an agent, and the time. A document links to
the lanes and acts that cite it, and an act can cite a Drawer item by id. That is the difference from
a shared drive: the team can see why a document changed.

## Decided by nick, 2026-11-06

1. **Permissions.** Everyone on the team adds, reads and updates. Only a **human admin** deletes. An
   agent never deletes, and neither does a person who is not an admin.
2. **Updates strike through.** An update never erases. Text that changed stays visible, struck
   through, with the new text beside it and the member who made the change. *(sloane's reading of
   "strikethrough to update"; nick approved it, 2026-11-06.)* This fits the versioned shape above: each save is a version,
   and a document shows what each save struck and added. A file is replaced the same way: the old
   file stays, marked replaced, until an admin deletes it.
3. **Sharing is a requirement.** Members need easy ways to share a document or a file, including with
   people off the team. That changes the design in three places:
   - **Links that leave the team.** A share link reaches someone who is not a member. It needs a
     reachable address (a hosted team, or the relay a local team uses for reach), an expiry, and a way
     to revoke it. [ADR 616](../../decisions/616-demo-audiences-read-at-broadcast-grade.md)'s watch
     links are the nearest precedent. big-body reads the security half before it is designed.
   - **The record.** Each share is an act: who shared what, with whom, and until when.
   - **Privacy.** A shared item leaves the team's machine. `PRIVACY.md` says so in the same PR that
     ships sharing.
4. **The name is Drawer.** nick weighed the names below and chose it, 2026-11-06. It joins the
   glossary (`docs/glossary/terms.ts`) in the first PR that ships it, with "Shelf" and "Files" in its
   Not column.
5. **Agents add, read and update from day one**, as members do. The strike-through record is how the
   team trusts an agent's update. Agents never delete (point 1).
6. **Everything else in this brief is approved** (nick, 2026-11-06): the daemon as its home,
   versioned documents first, storage counted against the Cloud allowance, the dogfood cap, and the
   dogfood's measures and falsifier.

## Names to weigh

Each is weighed against the office the product already draws ([ADR 578](../../decisions/578-the-office-and-knowledge-work.md))
and the glossary's rule of one word per concept. The office scene on `/live` already has a bookshelf
that opens the wiki ([ADR 747](../../decisions/747-team-wiki-read-from-the-team-repo.md)) and draws
filing cabinets (`packages/web/src/live/office-scene/render.ts`), so any office-object name can open
from something already in the room.

| Name | For | Against |
| --- | --- | --- |
| **Drawer** | nick's word; one cabinet drawer in the office opens it; short, ownable | It reads as one person's drawer; "team drawer" may be needed at first |
| **Cabinet** | The whole filing cabinet, shared by the room; files and folders fit it | Formal; also a word for a government |
| **Files** | Nobody asks what it means; the noun people already search for | Generic; documents people edit together are more than files |
| **Binder** | Pages people add to and annotate over time, a good fit for strike-through updates | Reads as paper documents and fits files less well |
| **Locker** | Ownable, an office object | Reads as private storage, the opposite of a shared place |

**Chosen: Drawer** (nick, 2026-11-06). After two weeks, re-check it against what members called it
unprompted in acts.
"Shelf" is out: the wiki's bookshelf already has that word.

## Storage and its cost

This is pricing advice, and the call is nick's ([ADR 461](../../decisions/461-pricing-and-business-model.md)).

- **On your own computers, storage costs musterd nothing.** The Drawer's files sit on the team's own
  disk. ADR 461 §1 keeps the team layer free and uncapped there, so a local Drawer is free. The cap
  is a disk-safety default the team can change. It is never a price.
- **On musterd Cloud, we pay for every byte.** Cloudflare R2 lists object storage at about
  **$0.015 per GB-month**, with 10 GB a month free and no egress fees (Cloudflare's own page).
  Amazon S3 Standard is about **$0.023 per GB-month**, plus egress (third-party guides citing AWS's
  US East rates; AWS's own page not read). Both read 2026-11-06. At R2's rate, 10 GB a team for a year
  costs about $1.80 before requests.
- **Proposed:** Drawer storage on Cloud counts against the free allowance ADR 461 §2 already defines.
  Paid plans include more, and an org plan sets its own. That keeps one meter, the one Cloud already
  needs, and a person can forecast it. The amounts come from design partners, like every other number
  in ADR 461 §5.
- **For the dogfood:** our team runs on our own hub, so the dogfood costs nothing in storage. A
  per-file cap of 100 MB and no refused types is enough to learn from. Executables and archives are
  the first kinds to reconsider once sharing reaches people off the team.

## The dogfood, and how we would know

- **Scope:** our team, two weeks, versioned documents and files, on `/live`, the phone app and MCP.
- **The test case it must pass on day one:** a seat writes text for nick; nick opens it on his phone
  and copies it, with no PR and no page outside musterd.
- **Measures**, read from the daemon's own store (no product analytics; [`PRIVACY.md`](../../../PRIVACY.md)):
  - items created per week;
  - items opened by a member other than their author;
  - items opened from a different surface than the one that created them;
  - documents with two or more authors.
- **Falsifier**, proposed: after two weeks, fewer than half the items are opened by someone other than
  their author. Then the Drawer is working as a personal scratchpad. It does not become a product
  feature in this shape.

## Next steps

1. ~~nick picks the name and confirms the reading of "strikethrough to update".~~ Done 2026-11-06.
2. miley designs the surfaces (`/live`, phone, the MCP tools' names and shape within the context
   budgets CI checks); an engineer designs the store and the wire.
3. Any protocol change and any new dependency get their ADR before code (AGENTS.md hard rules 1 and 6).
4. Build the dogfood as a Goal with one lane per step (ADR 487).

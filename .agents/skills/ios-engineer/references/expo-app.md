# Expo app: screens, navigation, state, local-first data

The everyday craft. The app is TypeScript end to end and shares exactly one thing with the
rest of the repository: the protocol package, over the wire.

## Rules

1. **Import the protocol device-safely.** Use every protocol subpath the team names in
   `references/team.md` — on this stack the data subpath and the errors subpath, both —
   (never a barrel that pulls in server runtimes a phone lacks), and
   parse every response with its schema before any field is read. A parse failure is an
   error state the user sees, not a crash and not a silent empty screen.
2. **Validate forms with the server's own schema.** The edit form refuses exactly what the
   server would refuse, with the same message shape. Never re-implement a rule by eye in
   the component.
3. **Local-first, server-wins, said out loud.** Render the on-device copy; sync on launch,
   on foreground, after every write, and on pull-to-refresh. Writes made offline queue
   (one queued write per record; a second edit folds into the first and keeps its base).
   The server's timestamp wins a conflict, the queued write is dropped, and the sync line
   names what was dropped. An unreachable server or a 5xx stops replay with the queue
   intact; a refused write (4xx) is dropped and named. Every request has a short timeout —
   a sleeping host must never hang a sync.
4. **Creates are idempotent.** A create carries a client-generated key the server treats
   as its idempotency key, so a committed POST whose answer was lost replays into the same
   record, never a duplicate.
5. **Times are wall-clock in the record's own zone.** When that differs from the phone's
   zone, the row and the edit sheet say whose clock the times are on. Never render a stored
   time in device zone silently.
6. **Navigation is the router's file structure.** Expo Router routes are files; deep links
   and notification taps land on routes, not on imperative navigation state. A notification
   that needs an in-app screen opens that route with the record's id and nothing else.
7. **Performance is a feature on a phone.** Lists use the SDK's performant list primitives,
   stable callbacks and memoised rows; heavy work leaves the JS thread; images are sized
   to their slot. Check with the React Native performance skills the team has installed
   (see `PROVENANCE.md`) before inventing a pattern.
8. **Every screen designs its states.** Loading, empty, error, offline-with-local-data,
   and conflict-dropped are distinct, visible states. A screen that only works online
   with ideal data is unfinished (the designer role judges the look; you own that the
   states exist and behave).

## Procedure for a screen or data change

1. Read the wire shape in the protocol package and the architecture doc section the team
   names; state the routes, schemas and local-store changes before editing.
2. Write or extend the pure view/sync logic first, with its unit tests — the team's app
   package tests its logic in Node, with no native build.
3. Build the screen against the local store, then wire sync; check the offline path by
   running with the server unreachable.
4. Run the changed flow (see `references/testing-and-verification.md`), screenshot it,
   then typecheck and run the package tests.

## Sources

Expo documentation for the pinned SDK (Router, SQLite, Secure Store), the React Native
performance skills recorded in `PROVENANCE.md`, and the team's architecture doc for this
surface. Where they disagree with this file, the team's decision record wins.

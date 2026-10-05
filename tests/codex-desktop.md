# Codex desktop verification matrix

This is the manual acceptance record for the Codex desktop Surface described by
[ADR 216](../docs/decisions/216-codex-cli-residency-backend.md). It verifies ordinary MCP
coordination and explicitly does not advertise desktop daemon wake. Run it in a trusted project
workspace with the musterd daemon already serving the target Team.

Procedure audit 2026-08-24 (dolly): the matrix steps and tool names remain current against main;
note the enrolled workspace must carry a strict v2 binding and the ADR 286 launch-Surface marker
(`musterd harness configure` writes both). At that audit, nine rows were `pending` and needed a human operating
Codex desktop. Nick performed the current run below; automation did not stand in
for the manual observations.

## Run metadata

| field                 | value                          |
| --------------------- | ------------------------------ |
| date                  | 2026-10-05                     |
| operator              | nick                           |
| Team                  | revive                         |
| workspace             | `/Users/nick/musterd/revive/agents/gptbot` |
| desktop project root  | verified by Nick: `/Users/nick/musterd/revive/agents/gptbot` |
| daemon                | `http://127.0.0.1:4849`        |
| Codex desktop version | `26.825.51511`                 |

## Matrix

For each row, record the observed evidence and set `pass` to `yes` or `no`. A `no` means the
failure interpretation applies; it is not permission to infer a stronger capability.

| check                     | procedure                                                                           | expected evidence                                                                                                                 | pass                      | failure interpretation                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| trusted project           | Open the enrolled workspace in Codex desktop.                                       | The project opens without a trust prompt that bypasses the project configuration.                                                 | yes — observed 2026-10-05 (Nick confirmed the canonical GPTBot path; no trust prompt) | Project trust or configuration loading is unresolved; do not continue to wake claims.                |
| MCP load                  | Run `/mcp` and inspect the server list.                                             | `musterd` appears and is enabled.                                                                                                 | no — observed 2026-10-05 (enabled in Settings → MCP servers, omitted from the workspace `/mcp` list; initialization and tool invocation succeeded; prior desktop yes observed 2026-08-03) | The workspace list disagrees with working MCP tools; registration failure is not established.        |
| MCP tool invocation       | Discover musterd tools and call `team_inbox_check`.                                 | The MCP tool returns actual Team inbox data.                                                                                      | yes — observed 2026-10-05 (GPTBot discovered `mcp__musterd__team_inbox_check` and returned the revive inbox; Nick supplied the exact result) | Investigate tool discovery or execution if this call fails.                                         |
| explicit join             | Ask the session to call `team_join` for its assigned Member.                        | A new Presence appears for the expected Member and `codex` Surface.                                                               | yes — observed 2026-10-05 15:28 PDT (Nick relayed desktop MCP `team_join` success as gptbot on revive/codex; independent roster confirms a session Presence attached at 15:29:20 PDT, model gpt-6-luna) | MCP is reachable but identity or binding is wrong; inspect the local binding and daemon Team.             |
| claim approval            | Complete any required claim/grant approval through the normal musterd flow.         | The Member becomes present without a second untracked identity.                                                                   | yes — existing-seat authorization observed 2026-10-05 (desktop reported successful join with no approval request; roster shows one gptbot Member and one codex Presence; a fresh approval-required claim was not exercised) | Authorization or seat binding is not proven. Do not treat tool availability as occupancy.            |
| directed delivery         | Send a directed Act to the desktop Member from another Surface.                     | The Act appears in the desktop session's `team_inbox_check` result.                                                               | yes — observed 2026-10-05 (Nick sent `CD-20261005-1`, Act `01M46Z6BP5SQJT2GZKFKRRQH8A`; GPTBot's first MCP inbox call returned it addressed to gptbot) | Durable delivery or Member routing is broken. Check the daemon before retrying.                      |
| inbox drain               | Call `team_inbox_check` and acknowledge the delivered Act.                          | The Act is no longer unread on the next inbox check.                                                                              | yes — observed 2026-10-05 (the next MCP inbox call omitted `CD-20261005-1` and returned `no new messages — nothing waiting on you`) | Cursor advancement or acknowledgement is not working.                                                |
| duplicate-seat protection | Start or reload a second Codex desktop session using the same agent seat.           | The existing agent Presence is protected by the normal newest-wins/superseded behavior; no parallel autonomous identity persists. | yes — observed 2026-10-05 (second desktop chat joined; audit `claim.superseded` at 15:33:19 PDT records same_workspace=true, evicted=1, successor_surface=codex; roster has one codex Presence; Nick relayed the original chat's single MCP `team_status` failure at 15:35 PDT: `Transport closed`, with no reclaim/retry) | Seat protection is unverified. Do not call this two-session behavior supported.                      |
| project isolation         | Open a different project without its musterd binding and inspect `/mcp`.            | The second project does not silently inherit the enrolled workspace's Member identity.                                            | yes — observed 2026-10-05 15:38 PDT (Nick opened unbound `/Users/nick/codex-desktop-isolation-20261005`; `/mcp` omitted musterd and the new chat reported no musterd tools in its catalog; no join/claim/tool call performed) | A credential or binding crossed workspace boundaries. Stop and rotate credentials if exposed.        |
| reload/reconnect          | Run `/mcp reload`, then call `team_status` and `team_inbox_check`.                  | The server reconnects, the expected Team remains selected, and the Member can continue after any normal rejoin.                   | yes — observed 2026-08-03 | The adapter process is stale or cannot reconnect; inspect the MCP target and daemon build stamps.    |
| model/build attestation   | Inspect `team_status` and the daemon roster after joining.                          | The expected model and build warning/attestation state is visible; a mismatch warns rather than silently claiming parity.         | yes — normal matching-build case observed 2026-10-05 (`team_status`: gptbot, codex, gpt-6-luna, no warnings; roster: observed model and adapter build `ab7353886b038d76a8ef9871046fd5fab67af831`; `/health` reports the same daemon build; mismatch-warning case not exercised) | Runtime provenance is missing or stale. Rebuild/reload before accepting the result.                  |
| offline manual resume     | Stop the desktop session, send it a directed Act, then reopen the project manually. | The Act is available from the durable inbox after reopening; no daemon wake is claimed.                                           | yes — observed 2026-10-05 (Nick quit the app; roster showed gptbot offline/no Presence before and after sending Act `01M473Q9XY5CXX3ZFH1E28WZY9`; after manual reopen the first MCP inbox call returned `CD-20261005-OFFLINE-1` and the second omitted it; no automatic wake event observed) | Durable inbox delivery is broken, or the test accidentally relies on unsupported desktop automation. |

## Result and limits

The 2026-10-05 run records eleven passing rows and one failed UI-list row. Actual
MCP calls prove ordinary Team coordination even though Nick still reports musterd
missing from the bound workspace's `/mcp` list after reopening. The installed `/mcp` menu requests a host-level inventory without `threadId`;
see the UI diagnostic below. The entry remains omitted, but no configuration
repair is inferred from that menu.

Authorization was exercised with GPTBot's existing seat, which returned no new
approval request. The approval-required claim branch and build-mismatch warning
branch were not exercised. Reload/reconnect retains its separate 2026-08-03
observation; the current run exercised a full manual app reopen.

## UI-list diagnostic, 2026-10-05

Nick supplied `Screenshot 2026-10-05 at 3.53.39 PM.png`: the new-task composer in
GPTBot's project shows the `/mcp` status submenu with global servers, omitting
musterd. Actual MCP calls from tasks in that project have already succeeded.

Read-only inspection of the installed app bundle at
`/Applications/ChatGPT.app/Contents/Resources/app.asar` identifies the matching
menu renderer (`R9e` / `j9e` in `app-primary-c0280d43ce72.js`). It obtains server
statuses from the host-only query `LSn` (`xSn` in `app-shared-9d148924be0b.js`),
which calls `mcpServerStatus/list` without `threadId`. A separate query `RSn`
passes `threadId`, but the displayed submenu does not use it. Its item renderer
iterates only the returned server statuses; project config can affect the enabled
label but cannot add an absent server to that list.

This query-scope difference explains why the submenu is not evidence that a
project-scoped MCP adapter failed to load. The installed menu is still missing
musterd and the literal UI-list expectation remains `no`; it has not been patched.
This observation is scoped to app version `26.825.51511` and would be overturned
by an updated menu using a thread-specific query or a reproduction showing
musterd absent from the task's actual tool catalog. No global musterd registration
or vendor app modification was made.

## Capability boundary

Desktop diagnostic 2026-10-05: thread `01a10de8-2117-7013-837e-ae948a3ee514`
has the canonical GPTBot cwd in its session metadata. Desktop logs report
`server=musterd status=ready` at 21:11:31 UTC and again at 21:15:38 UTC after
restart. Nick subsequently confirmed the server is enabled in Settings → MCP
servers but omitted from the workspace `/mcp` list. GPTBot then discovered and
successfully called `mcp__musterd__team_inbox_check`, returning actual revive inbox
data. The roster independently showed GPTBot online on the `codex` Surface with
observed model `gpt-6-luna` and adapter build `ab7353886b038d76a8ef9871046fd5fab67af831`.
Initialization and tool invocation therefore work; the remaining failure is the
workspace list's visibility. The later UI diagnostic below identifies the
menu's host-level query. The earlier inference
that desktop never loaded the project MCP configuration is invalidated. The
harness's `unmanaged-conflict` classification concerns fragment reconciliation and
is not evidence of MCP startup failure.

Codex desktop is coordination-capable through its project MCP configuration. It is not a
daemon-wakeable residency backend. A manual app reopen, `/mcp reload`, or reconnect proves ordinary
coordination only; it does not prove exact task targeting, lifecycle observation, or safe wake/resume.
Desktop may be advertised as wakeable only after a versioned, supported API proves all three seams.

The Codex CLI backend is separate: its capability probe and owner-gated real acceptance test do not
upgrade the desktop Surface.

Join verification 2026-10-05 15:28 PDT: Nick relayed the desktop MCP join/status
report: gptbot joined revive on codex without an approval request. The current
roster independently confirms gptbot online with one session Presence, observed
model gpt-6-luna, and adapter build `61a79f9a87b06663b997c7925a06cf6a71eb81d1`,
matching `/health`. The inbox contained a guardian `daemon_down` alert; at this
check `/health` returned `ok: true`, so the alert does not describe the daemon
state observed here. Its original failure and recovery were not investigated.

Offline-reopen verification 2026-10-05: Act `01M473Q9XY5CXX3ZFH1E28WZY9`
was sent at 22:42:33.023 UTC after Nick quit the desktop app and the roster showed
no gptbot Presence. Nick relayed both MCP inbox results after manually reopening:
the first included `CD-20261005-OFFLINE-1`, the second returned no new messages.
The new session metadata identifies Codex Desktop, GPTBot's canonical workspace,
and start time 22:43:51.063 UTC. Audit shows a CLI Presence at 22:44:22.882 UTC
followed by the codex session Presence at 22:45:13.001 UTC, both after that manual
reopen. No residency wake event was observed in the intervening gptbot audit
records. This proves durable inbox receipt and drain after manual reopen; it
does not establish desktop daemon wake.

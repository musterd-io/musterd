# Fly token attenuation — narrowing the hub's seat-machine token to start/stop

A Fly deploy token can be attenuated to read, start, stop and signal only the machines it names, refusing exec, config update, create, delete, secrets and registry push; measured live 2026-11-06 for the ADR 816 rule 2 follow-up.

## Why this page exists

[ADR 816](../decisions/816-hub-starts-stops-fly-seat-machines.md) rule 2 stages an app-scoped Fly
**deploy** token in the hub daemon's environment (`MUSTERD_FLY_API_TOKEN`) so the daemon can start
and stop seat machines. It named two exposures: (a) deploy-grade reach — image deploy, which is
code execution on the seat's machine — and (b) every resident seat on the hub runs as the daemon's
unix user and can read the token from `/proc/<pid>/environ`. Its follow-up says phase 2a must
first either attenuate the token to start/stop or move it behind a separate unix user, and that
whether the caveat vocabulary could do the first was unverified. This page verifies it.

## The caveat set that works (2026-11-06, lane 01M6S36XB0; falsify: rerun the probe below and see exec, update or push succeed with the attenuated token) <!-- claim: other -->

Two caveats, appended with `fly tokens attenuate` (flyctl v0.5.5) to a deploy token minted with a
short expiry:

```json
[
  { "type": "Machines", "body": { "machines": { "<machine id>": "rC" } } },
  {
    "type": "IfPresent",
    "body": {
      "ifs": [{ "type": "Commands", "body": [{ "args": ["/musterd-no-exec"], "exact": true }] }],
      "else": "rC"
    }
  }
]
```

- `Machines` limits the token to the listed machine ids, with actions `r` (read) and `C`
  (control — "starting/stopping/signaling machines", `resset/action.go` in
  [superfly/macaroon](https://github.com/superfly/macaroon)). List every machine the daemon's
  `flyMachines` mapping names for that app.
- **`Machines` alone is not enough.** With only the first caveat, `POST /machines/<id>/exec` ran
  `echo hi` and returned its stdout (2026-11-06) — Fly checks exec as an `r`/`C` action on the
  machine, so a start/stop token could still run any command on the seat. The `IfPresent` +
  `Commands` caveat closes it: an exec request carries a command, so the `Commands` caveat applies
  and allows only the one sentinel command, a path no seat image ships; a request that
  carries no command falls through to `else: "rC"`.

Minting it for a seat app (run where `fly auth` is the org owner; the token never goes in argv on
the hub, in the team store, or in a log line):

```sh
umask 077
fly tokens create deploy -a <app> -x <duration> > deploy.tok      # never the 20-year default
fly tokens attenuate -t "$(cat deploy.tok)" -f caveats.json > seat-start-stop.tok
rm deploy.tok                                                     # the parent is not staged
```

Attenuation only narrows, so a leak of `seat-start-stop.tok` yields that token's reach and no
more. The parent deploy token stays valid until its expiry; revoke it with
`fly tokens list -a <app>` and `fly tokens revoke <id>` if it must not outlive the staging.

## What the attenuated token can and cannot do (2026-11-06, throwaway app `musterd-token-probe`, one alpine `sleep` machine, destroyed after; falsify: any 403 row below answering 2xx on a rerun) <!-- claim: other -->

| Request (Machines API unless noted)                   | `Machines rC` only | `Machines rC` + `IfPresent Commands` |
| ----------------------------------------------------- | ------------------ | ------------------------------------ |
| `GET /machines/<id>`                                  | 200                | 200                                  |
| `POST /machines/<id>/stop`                            | 200                | 200                                  |
| `POST /machines/<id>/start`                           | 200                | 200                                  |
| `POST /machines/<id>/signal` (SIGHUP)                 | —                  | 200                                  |
| `POST /machines/<id>/exec`                            | **200, ran**       | 403                                  |
| `POST /machines/<id>` (update config / image)         | 403                | 403                                  |
| `POST /machines` (create)                             | 403                | 403                                  |
| `DELETE /machines/<id>`                               | 403                | 403                                  |
| `POST /machines/<id>/lease`                           | —                  | 403                                  |
| `POST /machines/<id>/metadata/<k>`                    | 403                | —                                    |
| `GET /machines` (list)                                | 403                | —                                    |
| `GET /apps/<app>/secrets`                             | 403                | —                                    |
| `fly secrets set --stage` (GraphQL)                   | —                  | unauthorized                         |
| registry `POST /v2/<app>/blobs/uploads/` (image push) | —                  | 404 `NAME_UNKNOWN`                   |

`—` = not probed with that token. The unattenuated deploy token, same app, got 202 on the registry
push start and staged a secret. The daemon's client (`packages/server/src/protocol/flyMachines.ts`)
uses exactly `GET`, `/start` and `/stop`, all allowed, and sends `authorization: Bearer <token>`;
the attenuated token answered 200 to `Bearer` both with and without its `FlyV1 ` prefix.

## What still leaks if a resident seat reads it (2026-11-06; falsify: a `GET /machines/<id>` on a seat machine whose `config.env` carries a credential) <!-- claim: other -->

Exposure (b) is unchanged: a resident seat can still read the token from the daemon's
environment. What that buys it is now availability only: it can stop, start or signal the named
machines (stopping a seat is a wrong stop, which ADR 816 already prices as one cold start), and read
their config. The config carries no secret: on `musterd-agent-delta-2`'s machine `87e126c01399e8`
`config.env` holds only `FLY_PROCESS_GROUP`, `MUSTERD_HOST`, `MUSTERD_HUB`, `MUSTERD_HUB_PORT`,
`MUSTERD_MODEL`, `MUSTERD_SERVER`, `MUSTERD_TEAM`, `PRIMARY_REGION`, `REPO_URL`, `ROSTER_REPO`, and
no `files` — the seat credential is a Fly secret, which `GET` does not return. A seat app that
puts a credential in `config.env` or `config.files` breaks this.

So exposure (a) — code execution on another seat's machine — is closed by attenuation, and the
separate-unix-user staging is not needed for it. Separate-user staging remains the answer if a hub
ever holds machines whose availability a resident seat must not be able to touch.

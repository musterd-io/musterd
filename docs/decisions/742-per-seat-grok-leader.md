# 742 — a per-seat Grok leader

- Status: accepted
- Date: 2026-10-26

## Context

Idle push into a Grok chat is `session/prompt` on a leader socket (ADR 558). A default `grok` does not listen. `[cli] use_leader` is one user-wide switch, and the leader's folder becomes the seat of every chat attached to it. `grok leader kill` also stops every socket named `~/.grok/leader-*.sock`. The injector reads `GROK_LEADER_SOCKET` from the musterd MCP process. `buildMcpEnv` returns an empty env on purpose (ADR 165), so a shared MCP slot cannot carry one seat's socket.

## Problem

Opting one seat in was a checklist: a private socket path, `--leader`, `--leader-socket`, the seat folder as cwd, and the same path in the MCP process's environment. An already-open chat does not attach to a leader started later, so that chat still has to be opened again. The rest of the checklist is musterd's to do.

## Decision

1. The per-seat socket is `~/.musterd/grok-sockets/<file>.sock`, where `<file>` is the first 32 hex characters of sha256 of the seat folder's real path, plus `.sock`. `MUSTERD_CONFIG` moves the directory with the rest of the machine state (ADR 190). The name is not under `~/.grok/` and does not match `leader-*`.
2. `musterd grok`, run in the seat folder, execs `grok --leader --leader-socket <that path>` with that folder as cwd and `GROK_LEADER_SOCKET` set to the same path. It does not set `use_leader` and does not create `~/.grok/leader.sock`.
3. The seat launcher does the same for a Grok fresh start and a Grok resume. Host wakes do not. They never used this launch plan.
4. The injector checks, in order: `GROK_LEADER_SOCKET` when set; the per-seat socket when that file exists; then `$GROK_HOME/leader.sock` or `~/.grok/leader.sock`. A missing socket stays `no-leader-socket`. A plain `grok` stays deaf.
5. The filename function is duplicated in the CLI and the MCP adapter, because only `@musterd/protocol` crosses that boundary. Both lock the hash of the string `/seats/dreamy` to `65972905c9dfa3cdb961dfa2727d5422.sock`.

## Consequences

- Opening `musterd grok` in a seat folder starts a new Grok process. A chat that is already open keeps running and stays deaf until that restart.
- The MCP child finds the socket from the seat folder even when its configured env is empty. The env var is still set, so an adapter that only knows the override also finds it when the child inherits the environment.
- `docs/architecture/05-mcp.md` is unchanged here. Another lane holds that file.
  Follows-up: deferred — when the hold on `docs/architecture/05-mcp.md` lifts, that file's grokLeader line names the per-seat socket preference (2026-10-26)

## Observability & Evaluation

**Traces.** No new row. `idle_wake.injected` already records the harness and the reason. `no-leader-socket` remains the deaf probe.

**Eval.** The filename lock, the injector's three-way path choice, `musterd grok`'s argv, and the launcher's Grok argv are unit tests.

**Experiment.** n/a — one restart of a named seat is the falsifier, not a pre-registered window.

# 656 — Resident bash sandbox

- Status: accepted
- Date: 2026-10-17

## Context

ADR 588 gives a native resident seat four working tools. Its jail checks each path and command
before execution, strips credential-shaped environment variables, and limits bash to declared
scripts and a small command set. That check keeps the model-facing surface narrow, but a declared
package script can execute arbitrary workspace code as the host user. Ryder's #2849 fixed bypasses
in that command check; this decision adds the OS boundary that the command check cannot provide.

## Problem

Code run by `pnpm test`, a declared package script, or another allowed command could otherwise read
host credentials, write outside the workspace, or open arbitrary network connections. The resident
seat's key is already removed from the child environment, but environment scrubbing alone does not
protect other host files or credentials.

## Decision

Every resident bash child runs inside a platform OS sandbox. Unsupported platforms and unavailable
sandbox facilities fail closed; there is no direct-shell fallback.

On macOS, use the system `sandbox-exec` with a Seatbelt policy that denies by default. It grants
workspace reads and writes, temporary-directory writes, read-only access to the pnpm store and
runtime files, and network access only to configured loopback gateway ports. The policy denies
`.musterd` access and `.git` writes. It stages the Corepack pnpm cache into a private temporary
directory, keeps the host home out of the readable roots, and passes only the supported gateway URL
variables to the child. `sandbox-exec` is deprecated by Apple; keep this backend isolated in one
file and fail closed if the command or policy stops working.

On Linux, use bubblewrap with user, PID, and network namespaces ([upstream options](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)). The workspace is writable;
`.musterd` is a private tmpfs, `.git`, the pnpm store, the runtime, and the staged Corepack cache are
read-only, and the host home is not mounted. The child has no host network. For a configured gateway,
a host-side relay forwards a single Unix-domain socket to that gateway's loopback port; an in-namespace
listener exposes that relay on the matching loopback port. No other host port or external network is
reachable from the child. If bubblewrap or the required namespace support is unavailable, the bash
tool fails closed.

Landlock is not layered on top in this version. Bubblewrap's mount namespace gives the filesystem
boundary, while its network namespace plus the single-port relay gives the network boundary. Landlock
network rules constrain TCP bind/connect operations by port ([kernel documentation](https://docs.kernel.org/userspace-api/landlock.html)) but cannot distinguish the remote address, so Landlock alone cannot express the gateway destination rule. It remains a possible additional Linux defense after a runtime evaluation; it is not needed to make the child boundary structural here.

The existing `jail.ts` command and path checks remain in place as defense in depth and for clear
preflight errors. No runtime dependency or protocol schema is added.

## Consequences

- Workspace scripts and tests may read and write project files, but the bash process cannot use the
  host home or host credentials. The pnpm store is available read-only.
- A child can reach only the resident gateway ports supplied by the host. Arbitrary loopback and
  external network access are denied.
- Linux hosts need bubblewrap and permission to create the required namespaces. A Linux runtime test
  must confirm those prerequisites and the Unix-socket relay on the supported host image.
- The macOS backend depends on Apple's deprecated `sandbox-exec`; a macOS change that removes or
  breaks it will stop resident bash until a replacement OS facility is adopted.
- The pnpm cache is copied to a per-child temporary directory so Corepack does not need host-home
  access. This adds startup I/O and the directory is removed when the child settles.

## Observability & Evaluation

- **Traces:** The existing wake/tool result records the child exit status and clipped output. Sandbox
  startup failures are returned as spawn failures; this boundary adds no environment, policy, or
  relay logging.
- **Eval:** The working-tools test runs an allowed package script that attempts to read a host-only
  file, confirms the marker is absent, confirms the configured gateway marker is reachable, and
  confirms a second local port is unreachable. Run it on macOS and Linux CI; Linux CI is required to
  provide the runtime evidence absent from the authoring Mac.
- **Experiment:** n/a — this is a security boundary, and the deny tests are deterministic acceptance
  checks rather than a product comparison.

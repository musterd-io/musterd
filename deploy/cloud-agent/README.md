# Cloud agent — one hosted seat on musterd compute, as a Fly machine

The runbook for ADR 647 phase 1: a Fly machine that hosts one sponsored seat against a
**hosted (Cloud) team**. It runs no daemon and holds no team store (design §4.1b): the host
loop polls the hosted server over HTTPS, provisions the seat under the sponsor-scoped host
key (ADR 648), and runs the resident engine in the seat's workspace.

Everything marked **$** creates a cloud resource or spends money — a human at the wheel.
The sponsor steps (minting the agent and the host key) run wherever the sponsor is bound.

## What the machine holds

| where              | what                                                              | survives redeploy |
| ------------------ | ----------------------------------------------------------------- | ----------------- |
| image `/app`       | this checkout's CLI build (deployed build, by construction)       | replaced          |
| volume `/data/home` | host registry, seat binding (`~/.musterd`)                       | yes               |
| volume `/data`     | workspace clone + seat workspace, logs                            | yes               |

Secrets arrive as Fly secrets, never in the image, `fly.toml` or the repo:

| secret              | who needs it                    | lifetime                              |
| ------------------- | ------------------------------- | ------------------------------------- |
| `MUSTERD_HOST_KEY`  | the host loop (ADR 648)         | the whole run; revocable server-side  |
| model key (`ANTHROPIC_API_KEY` or the `MUSTERD_KEY_ENV` variable) | the resident engine, at spawn | the whole run — the sponsor's BYOK key |
| `GH_TOKEN`          | clone, push, PRs from the workspace | the whole run — fine-grained, this repo only |

It must never hold: the team agent key (`MUSTERD_AGENT_KEY` — the entrypoint refuses to
boot with it set) or any sponsor credential. The sponsor's binding lives on the sponsor's
machine; ADR 648 is what lets this host finish provisioning without it.

## Create **$**

One script runs the whole of this section and First boot — no secret is copy-pasted:

```sh
deploy/cloud-agent/create.sh <seat> --repo <workspace-git-url>
# options: --org --region --team --server --host-label --key-env --skip-sponsor --dry-run
# --server defaults to https://<team>.musterd.dev, where a hosted team lives (cloud-ops.md);
# --team defaults to revive-staging, the staging team the pilot runs against.
```

It creates the agent and queues its provision, mints the host key (captured into a shell
variable, handed straight to `fly secrets set`, never printed), reads the model key and GH
token without echo, then creates the app and volume and deploys. Run it from a folder bound
to the team as the sponsor. `--dry-run` prints every step with secrets redacted.

By hand, the same steps are:

On the sponsor's machine, bound to the team:

```sh
SEAT=<name>        # the hosted seat this machine will run
musterd agent $SEAT                      # sponsors + queues the provision for a host
# a host key for this machine's label, minted by the sponsor (shown once — copy it now):
musterd team bootstrap mint --host cloud-$SEAT   # or your label; keep it consistent below
```

On the operator's machine:

```sh
fly apps create musterd-agent-$SEAT --org personal
fly volumes create agent_data --app musterd-agent-$SEAT --region sjc --size 3 --yes
fly secrets set --app musterd-agent-$SEAT \
  MUSTERD_HOST_KEY=msak_… \
  ANTHROPIC_API_KEY=sk-ant-… \
  GH_TOKEN=github_pat_…
```

Set the machine's non-secret env in `fly.toml` (`MUSTERD_SERVER`, `MUSTERD_TEAM`,
`MUSTERD_HOST` — the host label must match the label the provision was queued for), and
`REPO_URL` to the workspace repo the seat clones on first boot.

## First boot **$**

```sh
fly deploy --config deploy/cloud-agent/fly.toml --dockerfile deploy/cloud-agent/Dockerfile \
  --app musterd-agent-$SEAT --ha=false
fly logs --app musterd-agent-$SEAT
```

The log shows the provision claim, the seat standing up (workspace, credential, residency
enrolled under harness `musterd`), and then wake polls. On the team server, the seat reads
`offline · wakeable` until its first wake.

## Verify

1. **Provisioned.** The provision row for the seat reads `ready` (`musterd host provisions`
   from the sponsor's host, or the audit rows carrying `via: 'host_key'`).
2. **A cold wake.** Send the seat an act that wakes (steer/accept/a handoff). The machine's
   log shows the lease and the resident engine's turn; the roster flips the seat to `working`.
3. **A lane end to end** from the seat's workspace: claim → work → PR → `lane_submit`.
4. **No forbidden state.** `fly ssh console --app musterd-agent-$SEAT -C "env | grep -c
   MUSTERD_AGENT_KEY"` prints 0 (the boot would have refused it anyway), and no file on the
   volume is the sponsor's binding.

## Park / stop **$**

```sh
fly machine stop  <id> --app musterd-agent-$SEAT    # parked: volume only, no compute spend
fly machine start <id> --app musterd-agent-$SEAT    # boot is idempotent; polls resume
```

Parking the seat server-side (residency off / sponsor revokes the host key) and stopping the
machine are independent: do both to stop spend entirely, either to pause one half.

## Teardown **$**

```sh
# sponsor: revoke the host key and the seat's grant (or retire the seat)
fly apps destroy musterd-agent-$SEAT --yes          # machine AND volume
```

Revoke the GitHub token and rotate the model key if either was ever pasted anywhere but the
`fly secrets set` line.

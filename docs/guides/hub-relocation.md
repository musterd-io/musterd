# Hub relocation — runbook

Moves revive's hub from the laptop (`mac.lan`) to `musterd-joiner-1` (Hetzner hel1). The design is
[ADR 796](../decisions/796-hub-relocation.md) and
[the design doc](../superpowers/specs/2026-11-03-hub-relocation-design.md); the steps are
[the plan](../superpowers/plans/2026-11-03-hub-relocation.md). This page holds what the plan's
increment 4 checked on the box (lane `01M6HWV9E48ECHG1M77GX5HNDG`), the hardening still to do, and
the revocation list.

## The box as it stands (checked 2026-11-04)

| Check | Found | Needed for the switch |
| --- | --- | --- |
| Daemon listener (`ss -ltnp`) | `127.0.0.1:4849` only (it is a joiner) | As the hub it must bind the tailnet address `100.115.152.1:4849`, never `0.0.0.0` |
| Hetzner cloud firewall `joiner-ssh-only` | inbound TCP 22 from anywhere; nothing else | 4849 stays closed on the public IP: already true |
| Host firewall | `ufw` was inactive. Since 2026-11-04 it is on: deny incoming, allow 22/tcp, allow `tailscale0` | done |
| sshd | `PasswordAuthentication` was `yes`. Since 2026-11-04 it is `no` (`/etc/ssh/sshd_config.d/00-musterd.conf`); `PermitRootLogin without-password` (key only) | done |
| Tailnet ACL | the box was an untagged member with full reach. Since 2026-11-04 it is tagged `tag:musterd-hub`. It reaches only `nicks-laptop:4849` (checked: 4849 answers 200, 22 is refused), and `tag:musterd-seat` may reach the box's 4849 | after the switch, remove the `tag:musterd-hub → nicks-laptop` grant |
| App-channel key | absent on the box | arrives with the switch (design §"The app-channel key") |
| Relay credential (`away_relay_token`) | absent from the box's replica; team policy secrets do not replicate | arrives inside the copied store; rotate it after the switch |

The tailnet policy lives in the Tailscale admin console (login.tailscale.com → Access controls).
Members (`autogroup:member`) keep full reach, so every device on nick's account still reaches the
box, swethas-laptop included. Seat VMs and the hub box are tagged, so they are not members.

## The relay credential

[ADR 659 §4](../decisions/659-away-relay-protocol-and-credentials.md): there is one credential per
team, not per hub. The Worker secret `TEAM_CREDENTIALS_JSON` maps the team slug to a sha256 hash. The
credential lets the daemon talk to revive's relay object and nothing else; the object forwards
callbacks and never holds ask content. A per-hub credential cannot be minted, so the copy is
justified: the box gets the credential inside the copied store. After the switch, the operator rotates it:
a new credential's hash in `TEAM_CREDENTIALS_JSON`, and the new value in revive's policy
(`away_relay_token`) on the new hub. The relay then refuses the old socket's next frame, so the
laptop's set-aside store holds a dead credential.

## Rotate and re-pair (the app-channel key)

Run once on 2026-11-04 against the laptop daemon (the real one, on nick's answer to question
`01M6KYAKXD`). A separate test daemon would have needed its own team slug in the relay's
`TEAM_CREDENTIALS_JSON`, which is the same secret revive's relay uses. It passed. The steps:

1. Announce the bounce on `@team`.
2. On the daemon's machine, move `~/.musterd/app-channel.key` aside. Keep a copy: putting it back and
   restarting restores the old pairing, as long as the phone has not yet tapped "Pair again".
3. `musterd service restart --force`. The daemon makes a new key the first time a pairing starts,
   not at boot.
4. On /live, under **You → Your phone**, click **Pair another phone**. Note the daemon fingerprint
   beside the code.
5. On the phone, tap **Pair again**, then **Forget and pair again**, then scan.
6. Compare the app's **Daemon fingerprint** with the one beside the code. The other fingerprint on
   /live ("Confirming enrolls this phone's key") is the phone's own key; it is not for comparing.
   If they match, **Confirm with passkey**.
7. Unpair the old phone entry on /live. Its keys died with the old daemon key.
8. Check: send the person a `team_question`. It reached the phone, and the answer came back
   verified, via the app.

What made it harder than it should be (lane `01M6KYZ1SM`): a "Not my phone" on a pairing the server had
already closed left the panel stuck until a page reload, and nothing marks the old pairing as dead.
On switch day the same steps run against the box's daemon.

## Rehearsal 1 (2026-11-04, lane `01M6HWVB7F`)

The plan's increment 5, run once against a staging copy of the hub on the box (port 4859, bound to
`127.0.0.1` only, relay keys removed from the copy). Every copy was deleted after.

| Step | Time |
| --- | --- |
| Online snapshot on the laptop (`sqlite3 … ".backup …"`, 711 MB) | 3.4 s |
| Inventory of the snapshot (70 tables) | 7.6 s |
| Copy to the box over the tailnet (`scp`) | **148 s** (~4.8 MB/s) |
| Inventory compare on the box, before the new daemon starts | 4.8 s, `mismatches: []` |
| New daemon boot to `/health` | 1.1 s |
| Replica-only check (`--replica` box store `--hub` copy) | 2.0 s |

About 2 m 50 s of measured steps against the 30 minutes. The copy is the long pole; compress it
(`zstd`) on the day. The drain, the joiner re-point and the seat move were not rehearsed: they act on
the live team.

Findings, each to settle before the switch:

1. **The compare must run before the new hub boots.** Run after boot, it shows the rows any daemon
   writes on start (audit, sync log, session leases, `sync_meta`), and they read as mismatches.
2. **`inventory.ts` cannot compare its own output.** The default report is `{inventory: {tables}}`,
   and `--compare` reads `{tables}`, so the documented snapshot-then-compare flow throws
   (`a.tables is not iterable`). The rehearsal unwrapped the file by hand.
3. **`inventory.ts` output cut off at 64 KB when piped.** A large `--replica` report ends mid-JSON.
   Redirect it to a file.
4. **The replica-only check compares row ids, but the box keeps its own.** The box's replica holds
   the team, members, roles, residency, seat memory and inbox cursors under node-local ids
   (team `01M64DHQ…` on the box, `01KWHV06…` on the hub). So it lists all 43 members as box-only,
   and the list cannot tell node-local ids from data that really exists only on the box. The tables
   it named: `audit` 40k and `tool_call_stats` 17k (node-local, expected), `messages` 15 (sent after
   the snapshot, which a drain would push), and `residency` 19, `seat_memory` 26, `seeds` 7,
   `grants` 3, `lane_samples` 65, `agent_bootstrap_credentials` 1, which need a carry rule in
   ADR 796 or an id-independent check before the switch.

Follows-up: findings 2–3 in lane `01M6MG73W5`; finding 4 in lane `01M6MG78J7`, which blocks the switch (lane `01M6HWVD5J`).

## Credentials on the box (the revocation list)

Each credential that lives on `musterd-joiner-1`, and the one step that revokes it. On a compromise,
run every row.

| Credential | Where on the box | Scope | Revoke in one step |
| --- | --- | --- | --- |
| Roster deploy key | `~/.ssh/musterd-revive-deploy` (fingerprint `SHA256:k+NnosWmsnBDVc30KV++KCNjY+iiRx/3WHu/CWVrIT4`) | write, `SandRiseStudio/musterd-revive` only; `main` protected against deletion and force-push | GitHub → SandRiseStudio/musterd-revive → Settings → Deploy keys → delete `musterd-joiner-1 roster` |
| GitHub token | `~/.config/musterd/github-token` (mode 600) | fine-grained, public repositories read-only, no permissions | github.com → Settings → Developer settings → Fine-grained tokens → `musterd-joiner-1 hub` → Delete |
| Node credentials (`msnode_`) | `~/.musterd/node.json`; after the switch, hashes in the store's `nodes` | sync with revive only | today, on the hub: `musterd node revoke <node-id>`. After the switch the box is the hub: revoke each joiner's node there, then re-enroll them |
| Host key | `~/.config/musterd/host.env` (`MUSTERD_HOST_KEY`) | hub-minted host credential (ADR 648): wake leases and provisions for the box's seats | it is a host-scoped bootstrap credential (ADR 395, ADR 344). As an admin on the hub: `musterd team bootstrap list` to find the `host` credential labelled `musterd-joiner-1`, then `musterd team bootstrap revoke <id>`. To replace it: `musterd team bootstrap mint --host musterd-joiner-1`, put the value in `host.env` as `MUSTERD_HOST_KEY`, and `systemctl --user restart musterd-host`. The rehearsal (increment 5) runs it once |
| Seat standing grants | each resident seat's `~/musterd/revive/musterd/<seat>/.musterd/binding.json` | that seat only | `musterd residency off` for that seat, from an admin folder (revokes the grant) |
| Model provider key | `~/.config/musterd/host.env` (`MUSTERD_RESIDENT_KEY`) | the API key for seats on musterd's own engine (not a musterd credential) | revoke it in the provider's console |
| App-channel key (after the switch) | `~/.musterd/app-channel.key` | the daemon's identity to every paired phone | set the file aside, restart the daemon, re-pair each phone ("Pair again") |
| Relay credential (after the switch) | inside `~/.musterd/musterd.db`, team policy `away_relay_token` | revive's relay object only | new hash in `TEAM_CREDENTIALS_JSON` (`wrangler secret put` on `workers/away-relay`), new value in revive's policy |
| OpenCode service password | `~/.config/opencode/service.json` | the box's OpenCode service | rotate it in OpenCode; it was shown in a session transcript on 2026-11-04, so rotate before the switch |
| Fly deploy token | `~/.fly/token` (mode 600), written 2026-11-04 for lane `01M6M3YG37` (Rider 7) | deploy to the `musterd-cooperbench` Fly app only; expires 2026-11-06 | `fly tokens list -a musterd-cooperbench`, then `fly tokens revoke <id>`, and delete the file |
| Tailscale node identity | `/var/lib/tailscale/` (the node key), node `musterd-joiner-1` tagged `tag:musterd-hub` | tailnet membership and every grant `tag:musterd-hub` holds | Tailscale admin console → Machines → `musterd-joiner-1` → Remove (revokes the node key), then rebuild or re-auth the box with a new key. Removing `tag:musterd-hub` from the ACL alone leaves the node on the tailnet |
| SSH host keys | `/etc/ssh/ssh_host_*_key` | the box's identity to every client that has it in `known_hosts` | `sudo rm /etc/ssh/ssh_host_* && sudo dpkg-reconfigure openssh-server && sudo systemctl restart ssh`, then each client deletes the old entry (`ssh-keygen -R 2.29.63.171` and `-R 100.115.152.1`) and accepts the new fingerprint read from the Hetzner console, not over the network |
| Box SSH access | `~/.ssh/authorized_keys` for `musterd` and `root` (the laptop's `~/.ssh/musterd-joiner`) | shell on the box | remove the line from both `authorized_keys`, or the Hetzner firewall rule for 22 |

Never on the box (design §"What never moves"): member credentials (`mskey_`, `msgr_`, `mscr_`), the
team-wide agent key, KMS or console access, `wrangler`, nick's passkeys, and `hcloud`.

## Residual risk

A compromise of the box exposes every credential above. The table bounds the damage and revokes it;
it does not remove the risk (big-body, design review 2026-11-03).

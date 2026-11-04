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

## Credentials on the box (the revocation list)

Each credential that lives on `musterd-joiner-1`, and the one step that revokes it. On a compromise,
run every row.

| Credential | Where on the box | Scope | Revoke in one step |
| --- | --- | --- | --- |
| Roster deploy key | `~/.ssh/musterd-revive-deploy` (fingerprint `SHA256:k+NnosWmsnBDVc30KV++KCNjY+iiRx/3WHu/CWVrIT4`) | write, `SandRiseStudio/musterd-revive` only; `main` protected against deletion and force-push | GitHub → SandRiseStudio/musterd-revive → Settings → Deploy keys → delete `musterd-joiner-1 roster` |
| GitHub token | `~/.config/musterd/github-token` (mode 600) | fine-grained, public repositories read-only, no permissions | github.com → Settings → Developer settings → Fine-grained tokens → `musterd-joiner-1 hub` → Delete |
| Node credentials (`msnode_`) | `~/.musterd/node.json`; after the switch, hashes in the store's `nodes` | sync with revive only | today, on the hub: `musterd node revoke <node-id>`. After the switch the box is the hub: revoke each joiner's node there, then re-enroll them |
| Host key | `~/.config/musterd/host.env` (`MUSTERD_HOST_KEY`) | hub-minted host credential (ADR 648): wake leases and provisions for the box's seats | revoke it on the hub, then restart `musterd-host` with a new one. The exact command is checked in the rehearsal (increment 5) before the switch |
| Seat standing grants | each resident seat's `~/musterd/revive/musterd/<seat>/.musterd/binding.json` | that seat only | `musterd residency off` for that seat, from an admin folder (revokes the grant) |
| Model provider key | `~/.config/musterd/host.env` (`MUSTERD_RESIDENT_KEY`) | the API key for seats on musterd's own engine (not a musterd credential) | revoke it in the provider's console |
| App-channel key (after the switch) | `~/.musterd/app-channel.key` | the daemon's identity to every paired phone | set the file aside, restart the daemon, re-pair each phone ("Pair again") |
| Relay credential (after the switch) | inside `~/.musterd/musterd.db`, team policy `away_relay_token` | revive's relay object only | new hash in `TEAM_CREDENTIALS_JSON` (`wrangler secret put` on `workers/away-relay`), new value in revive's policy |
| OpenCode service password | `~/.config/opencode/service.json` | the box's OpenCode service | rotate it in OpenCode; it was shown in a session transcript on 2026-11-04, so rotate before the switch |
| Box SSH access | `~/.ssh/authorized_keys` for `musterd` and `root` (the laptop's `~/.ssh/musterd-joiner`) | shell on the box | remove the line from both `authorized_keys`, or the Hetzner firewall rule for 22 |

Never on the box (design §"What never moves"): member credentials (`mskey_`, `msgr_`, `mscr_`), the
team-wide agent key, KMS or console access, `wrangler`, nick's passkeys, and `hcloud`.

## Residual risk

A compromise of the box exposes every credential above. The table bounds the damage and revokes it;
it does not remove the risk (big-body, design review 2026-11-03).

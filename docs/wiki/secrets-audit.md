# Secrets audit

What a repository-wide scan for committed secrets found, how it was run, and what it did not cover.

## 2026-10-26: no live credential in the tree or in history

Lane `01M5JQ3DJM`, dolly, at `origin/main` 5c61dabe (4,337 tracked files, 3,467 commits). Every finding
was classified from its file, line and shape. No value was printed or copied out, and none is written
here.

**No committed credential was found** (2026-10-26; falsify: re-run the four scans below — a hit outside `*.test.*`, `fixtures/` and `evals/` other than `packages/web/scripts/beacon.mjs`, or one that is not a class listed here) <!-- claim: other -->

| Scan | Hits | What they were |
| --- | --- | --- |
| `gitleaks git --redact` (history of the checked-out ref) | 39 | 33 test fixtures. 2 `private-key`: a fake PEM in `packages/protocol/src/traceScrub.test.ts` (the scrubber's own test) and a fixture in `workers/away-relay/src/index.test.ts`. 2 in the deleted `packages/whiteboard/vendor/squig/VENDORED.json`: SHA-256 file hashes. 1 false positive in a plan doc (a package filter, not a key). 1 public beacon token (below). |
| `gitleaks dir --redact` (working tree) | 36 | The same set, less the files since removed. |
| musterd's own prefixes (`mskey_`, `msgr_`, `mscr_`, `msac_`, `msnode_`, `msat_`, `msinv_`), tree and `git log --all -p` | 65 tree lines; 3 real-length bodies in history | A real token body is 32 base64url characters (`randomBytes(24)`, `packages/server/src/store/members.ts:121`). Every hit was in a test or a plan doc. The three real-length bodies were fixtures; the one with a random-looking body is the `forged` credential in `packages/server/src/transport/integration.governance.test.ts`. `gitleaks` has no rule for these prefixes, so this scan is the only one that sees them. |
| Secret-shaped files and credentialed URLs | 0 real | No `.env`, `.pem`, `.key`, `.p8`, `.p12`, `.jwk`, keystore or service-account file is tracked, or was ever added. Every `postgres://user:password@` URL points at a test host (`db.test`, `pool.example`, `direct.test`, `10.0.0.1`). No credentialed URL to Neon, Fly, Supabase, Upstash or AWS appears anywhere in `git log --all -p`. |

**One committed value is public by design.** `packages/web/scripts/beacon.mjs` holds the Cloudflare Web
Analytics beacon token. The file says why: it identifies the site and every visitor's browser reads it.
It grants nothing.

## What this did not cover

- GitHub Actions secrets, environments, workflow logs and artifacts, and PR or issue bodies.
- The roster repo (`musterd-revive`) and every other repository.
- Machine-local stores: `~/.musterd/` (config, `musterd.db`, `trace.db`), seat workspaces' untracked files, and the Keychain.
- History on branches other than those `git log --all` reaches from this clone (unfetched remote branches, deleted refs).
- Formats with no rule in `gitleaks`' default set and no prefix scan here.

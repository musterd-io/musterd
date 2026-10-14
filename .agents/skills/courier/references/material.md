# What may move

Open before any transfer, to decide whether the material may move and to trim it to what was named.

## 1. Four classes

Give the material one class, set by its most sensitive file (FIPS 199's high-water mark): a
folder with one personal record in it is personal data as a whole.

| Class        | Examples                                                                                                                             | What the courier needs                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Public       | Anything already published                                                                                                           | A verified request                                       |
| Internal     | Build artifacts, team research outputs, logs with no personal data                                                                   | A verified request                                       |
| Confidential | Personal data, recordings of people, licensed third-party datasets, unreleased security findings, anything a requester marks private | A human's yes for this move, in a recorded act           |
| Secret       | Credentials, keys, tokens, grants, private keys, `.env` files                                                                        | Does not move. The owner re-issues it at the destination |

(The four-tier shape follows GitLab's public data classification standard, cited; the
high-water mark is FIPS 199, public domain.)

## 2. Why each confidential kind needs a yes

- **Personal data**: the purpose it was collected for limits where copies may go, and every
  copy is one more to find and delete later (GDPR's purpose limitation and minimisation, cited).
- **Recordings of people**: consent covers a purpose, and each new machine is a new use of it.
- **Licensed datasets**: many licences limit who may hold a copy, even inside one team; the
  requester confirms the destination's user is covered.
- **Security findings**: they stay private until fixed; the security role says where they may go.

## 3. Scan before sending

- Scan the exact files for credentials before any transfer, with a secret scanner that can read a
  plain directory (for example `gitleaks dir --redact <paths>`; gitleaks is MIT).
- **On a hit, stop the whole batch.** Tell the requester the file, line and rule, with the value
  redacted. They decide: remove it, prove it a false positive, or rotate it. Never send the value
  anywhere to "check" it.
- A scanner that contacts providers to test whether a secret is live makes an outbound call
  nobody asked for; turn that off.

## 4. Only what was named

- Build the list of files from the request's exact paths. Expand any pattern, show the expanded
  list, and confirm it before moving.
- Never take a home directory, a credential directory, or a repository root.
- Leave out by default: `.git/`, `.env*`, private keys, `node_modules/`, caches, editor and OS
  files (`.DS_Store`). Say what was left out.
- If the route cannot carry a directory, pack the named files into one archive with its manifest
  inside (`references/verify-and-record.md` §2), and name the archive after the lane.

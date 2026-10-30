# 777 — A failed lock-screen check says open the app, and the phone keeps a coarse reason

- Status: accepted
- Date: 2026-10-30

## Context

ADR 676 decision 3: the phone shows nothing it cannot verify, and "a failed decrypt or signature
shows a generic 'an ask could not be verified' and offers no buttons". `09-mobile.md` adds that the
phone never says which check refused, because that distinction is an oracle.

The notification extension shows the same sentence for every refusal, and it has more than the
two cryptographic ones: no pairing pin yet, a relay fetch that fails or times out (the push was too
large to carry the seal inline), a keychain read or write that fails, and the extension running out
of time. On 2026-10-30 nick saw it on one or two of three test asks on build 35. The daemon had
delivered all three (HTTP 200), and its log showed the relay intermittently answering nothing.
Nothing on the phone recorded which check refused, so the failure could not be diagnosed.

## Problem

Two things are wrong with the sentence. First, it reads like an alarm for what is usually a slow
relay. Second, the fix is always the same, open the app: the app fetches the ask again and checks
it fully, so a refused lock-screen notification is not a lost ask. And because the phone keeps no
reason, a real fault looks the same as a flaky network.

## Decision

1. **The lock-screen fallback reads "New ask — open musterd to see it."** It still offers no
   buttons and shows nothing from the delivery. This replaces ADR 676 decision 3's sentence on the
   lock screen only. In the app, a delivery that fails the check is still "Not shown", with the
   existing in-app copy.
2. **The extension records a coarse reason for each refusal.** It writes `{reason, at}` to a new
   keychain item, `refusals` (same service, `AfterFirstUnlockThisDeviceOnly`). The item keeps the
   last 10 records, and nothing from the delivery: no ask text, no ref, no route. The reasons are:
   - `check`: every cryptographic and route check in one reason (decrypt, signature, route or
     binding mismatch, empty body). They are never told apart, so ADR 676 decision 3's oracle stays
     closed.
   - `fetch`: the relay fetch failed.
   - `timeout`: the extension ran out of time.
   - `keychain`: a keychain read or write failed.
   - `not-paired`: there is no pairing pin.
   - `malformed`: the push carried no musterd block.
3. **The app shows them as one line.** When refusals happened in the last 24 hours, the asks list
   ends with one muted line, for example "Diagnostics: 2 lock-screen checks failed today (fetch,
   timeout)". It shows nothing otherwise.

## Consequences

- A slow relay now reads as "open the app", and opening the app shows the ask.
- `fetch` and `timeout` separate network trouble from a real `check` failure. That is what was
  missing on 2026-10-30.
- Someone holding the unlocked phone can see the reasons. They are coarse and contain nothing from
  any ask, and `check` covers every cryptographic step, so whoever controls a delivery learns no
  more than the generic text already told them.
- `notice.ts` keeps `UNVERIFIED_TEXT` for in-app use and gains `LOCK_SCREEN_FALLBACK_TEXT`. The
  Swift drift test pins the new sentence. 09-mobile.md is updated in the same change.

## Observability & Evaluation

n/a — no agent-facing behaviour changes. The Diagnostics line is the evaluation: after the next
TestFlight build, a refused notification should name `fetch`, `timeout` or `check`. The falsifier:
a refusal on the lock screen that leaves no Diagnostics line.

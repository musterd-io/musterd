# 013 — A System One judge on our own coordination log: Jev and Laya both fail the pre-registered bars

> **Status:** 2026-09-29, lane 01M3QCVE6E (dolly). **Both arms complete — both reject.** Jev
> (`jev-1.13.0`, hosted, redacted text only) is far better than Laya but still misses both bars.

## Question

Could a typed-decision ("System One") model work as an **offline labeler** for the research corpus,
answering narrow questions about coordination acts cheaply? The use is offline only. The team's
2026-09-21 verdict still stands and is not re-litigated here: no such model in the daemon, in routing,
or in front of a send. That verdict came from wanderer's probe of Jev, where a wrong answer came back
at confidence 1.0, and from ryder's reasoning that a classifier in the send path turns a loud mis-send
into a quiet, plausible one. Outside evaluations since then
([priorbench/jev](https://github.com/priorbench/jev),
[jev-ood-calibration](https://github.com/scienthoon/jev-ood-calibration)) report the same pattern:
calibration that shifts with the domain, answers at exactly 0 or 1, and roughly a third of answers
changing when option names are swapped.

## Setup

- **Items:** 266 non-generated acts from the live message log, drawn by a seeded sample. Bodies are
  credential-scrubbed (`traceScrub`), member names are pseudonymised, and ULIDs are masked. The item
  file stays outside the repo (ADR 184) and is rebuilt with `node scripts/research/jev/dataset.ts`.
- **Truth is the observed outcome, not a label anyone assigned:**
  - the act the seat really sent (11 acts, plus a "none of these" option);
  - the `meta.species` the seat put on a real ask (consult / approve / escalate);
  - whether the addressee of a directed act actually replied. This is a proxy for "a reply was owed",
    and it is noisy.
- **Framings:**
  - *canonical:* options named by their musterd key;
  - *renamed:* opaque `option_N` keys in a shuffled order, with the same criteria text. The yes/no
    question becomes its negation.
- **Scoring:** a 40/60 tune/test split. The scorer reports accuracy, ECE (10 bins) and Brier, then
  fits one temperature on the tune split and re-measures on the test split.
- **Pre-registered reject:** post-fit ECE > 0.05, or framing flips > 10%.
- **Laya:** `@receptron/laya` (Convai, 421M ModernBERT, Apache-2.0), run locally on CPU through ONNX.
  It was installed in a scratch dir, not as a repo dependency. Reproduce with `run.ts laya` then
  `score.ts laya`.

- **Jev:** TypeSafe's hosted `system_one` API, pinned to `jev-1.13.0`, with 8 concurrent calls. Only
  redacted text was sent; nick authorized that on 2026-09-29, since TypeSafe offers no zero data
  retention. Reproduce with `TYPESAFE_API_KEY=… run.ts jev` then `score.ts jev`.

## Result — Jev (test split, n shown)

| question    | n   | acc   | ECE   | T fit | ECE@T | framing flips | top p ≥ .995 | median ms | verdict |
| ----------- | --- | ----- | ----- | ----- | ----- | ------------- | ------------ | --------- | ------- |
| act_choice  | 110 | 0.527 | 0.245 | 2.35  | 0.122 | **16%**       | 12%          | 327       | reject  |
| ask_species | 22  | 0.545 | 0.368 | 4.85  | 0.092 | **23%**       | 27%          | 510       | reject  |
| owes_reply  | 34  | 0.794 | 0.128 | 2.70  | 0.185 | **27%**       | 0%           | 473       | reject  |

**Jev is overconfident on every question.** Every fitted temperature is above 2: the stated
confidence has to be softened by that much before it means what it says. Even after the fit, ECE stays
at 0.09–0.19, against a bar of 0.05. On the reply question the fit made ECE *worse* (0.128 → 0.185),
because a 26-item tune split is too small to fit on.

**It is still confidently wrong, less often than Laya.** 9 of 165 act answers and 8 of 41 species
answers were wrong at ≥ 0.95. That is the same failure shape wanderer's 2026-09-21 probe found (wrong
at 1.0), now at a measured rate.

**Framing still moves it.** 16–27% of answers change with option names or order alone. That is lower
than Laya's rate and close to the outside reviews' "about a third", but above the 10% bar on every
question.

**The reply question is its best result** (79% accuracy on a balanced set, with no answers at the
extremes), and it is the only one near usable. Negating the proposition still flips 27% of its
answers.

## Result — Laya (test split, n shown)

| question    | n   | acc   | ECE   | T fit  | ECE@T | framing flips | top p ≥ .995 | verdict |
| ----------- | --- | ----- | ----- | ------ | ----- | ------------- | ------------ | ------- |
| act_choice  | 110 | 0.264 | 0.701 | 5.00\* | 0.094 | **47%**       | 76%          | reject  |
| ask_species | 22  | 0.409 | 0.187 | 2.40   | 0.098 | **59%**       | 0%           | reject  |
| owes_reply  | 34  | 0.353 | 0.458 | 5.00\* | 0.241 | **77%**       | 3%           | reject  |

\* the fit hit the grid ceiling. Even the strongest softening allowed did not reach the bar.

**It is confidently wrong, not just inaccurate.** On act choice, 93 of 165 answers were **wrong at
≥ 0.995**. The top answers were "none" (56) and "accept" (42). No threshold rescues that. It is the
wanderer probe's 1.0-while-wrong result reproduced at scale, on a second model.

**Framing decides the answer.** Between half and three quarters of answers change when only the option
names and order change. For the yes/no question, negating the proposition flips 77% of the answers.
The model is reading the surface of the question, not the message.

**The reply question scores below chance** (0.353 on a balanced set). Part of that is the proxy truth,
since a reply that never came is not the same as a reply that was not owed. But the 77% flip rate
shows the answers carry no stable signal either way.

**It is slow on this hardware:** median ~3 s per call on CPU (Apple silicon, ONNX), against the
advertised 33–40 ms on a T4 GPU. It is local, but it is not cheap here.

## Honest-N caveats

- One run, one seed, and small test splits: 22 items for species and 34 for reply.
- Our message bodies are long and dense with jargon (ADR numbers, lane ids, seat names). That is
  **out-of-distribution by design**, and it is exactly the regime the outside evaluations flagged.
- The reply truth is an observed-reply proxy.
- Laya misses every bar by a wide margin. Jev misses them by less: its act-choice flips (16%) and its
  post-fit species ECE (0.092) are nearest their bars. A larger N could narrow those two, but it is
  unlikely to close both at once.

## What it changes

- **Neither model is adopted as a corpus labeler.** Jev is the stronger of the two: roughly 2× Laya's
  accuracy, 3× fewer framing flips, and about 10× faster at median. Still, no question clears both bars.
  Laya, the local, no-retention option, does not work on our data at all.
- If labeling is revisited, the reply question on Jev is the only candidate. It would need a larger
  tune split (≥ 150) before a temperature fit means anything, and the framing flips would still
  disqualify it as a sole labeler.
- **The 2026-09-21 verdict is reinforced** (no System One model in the daemon or the send path). A
  second model reproduces confident-wrong answers and framing sensitivity on our own traffic.

# 013 — A System One judge on our own coordination log: Laya fails every pre-registered bar; Jev not yet run

> **Status:** 2026-09-29, lane 01M3QCVE6E (dolly). **Laya arm: complete — reject. Jev arm: pending** (no
> `TYPESAFE_API_KEY` on the dogfood box). This page is rewritten when the Jev arm lands.

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
- None of this changes the direction: every question fails both bars by a wide margin.

## What it changes

- **Laya is rejected as a corpus labeler** for coordination acts. The local, no-retention alternative
  does not work on our data.
- **The 2026-09-21 verdict is reinforced** (no System One model in the daemon or the send path). A
  second model reproduces confident-wrong answers and framing sensitivity on our own traffic.
- The Jev arm is ready to run. It only needs `TYPESAFE_API_KEY`, and it sends redacted text only (nick
  authorized this on 2026-09-29).

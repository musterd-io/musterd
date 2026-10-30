# Seats ask, you answer anywhere — design

- Date: 2026-10-30
- Lane: `01M673NMR7`, goal `away-channels`
- Brainstormed with nick; written by fifty. The parts marked **fifty's call** are mine; the rest is
  what nick said.

## Why

nick's laptop is underpowered and does too much: it is the hub and runs about a dozen seats. The
relief is to move seats off it, onto the Linux joiner box (`musterd-joiner-1`) today and onto hosted
musterd Cloud later. Moving seats only works if nick can still drive them without their terminals.

Today he drives them by hand. He opens each harness session, and when a turn ends he prompts it
again: to check its messages, take an acceptance request, answer a question it asked, tell it to keep
going, or restart its musterd MCP. The formal `ask`s he approves on `/live` and the phone app are
mostly yes/no. **A seat's real questions — "A or B?", or an open question — live in its chat session,
and on a remote box nobody is watching that session.**

nick expects other users with modest machines to hit the same wall. musterd Cloud also has to be an
option for users at scale. This feature is the piece both depend on.

## What it is

**A seat that stops to ask you something becomes a card you can answer from anywhere, and your
answer goes straight back into that seat's session.**

1. **Catch the question.** When a seat ends its turn on a question for a person, musterd turns it
   into an ask and marks the seat **waiting on you**, not idle.
2. **Answer it anywhere.** The card reaches `/live` and the phone at once, then Slack, then more
   channels, each as an adapter. Its options are buttons, and there is always a free-text answer
   (nick answers both ways today). Answering in one place clears it everywhere.
3. **Back to the seat.** The answer wakes the seat, wherever it runs, and reaches its session **word
   for word** as its next prompt, because it is a verified person's answer to that seat's own
   question.
4. **Quick actions per seat.** Start · Check inbox · Check PR · Resume, from any channel, plus a
   free-text "message this seat" box.

## Goals

- nick can run seats on the box for a full day without opening a seat terminal except for a deep
  dive.
- Every question a seat asks a person reaches that person, with enough context to answer without
  opening the terminal.
- An answer, typed or tapped, resumes the seat quickly and reliably wherever the seat runs.
- One design across `/live`, the phone and Slack; more channels plug in without redesign ("meet
  users where they are").
- The look and feel is magical, warm, fun, sleek, smooth, responsive, beautiful, delightful,
  intuitive, helpful and secure, with a slight SaaS feel (nick's bar). Where what exists falls short
  of it, replace it.

## Non-goals

- Moving seats to the box and running revive on hosted Cloud: separate later projects.
- Saved custom prompts: later, if nick catches himself typing the same thing twice (**fifty's
  call**).
- Replacing the yes/no approval flow for privileged acts (passkey approvals, ADR 662). Those stay as
  they are; this feature is for questions.
- A general chat client for seats. The "message this seat" box is one-off steering, not a chat app.

## Anti-goals (nick: these would make it a failure even if it technically worked)

- **Too complicated, adds overhead, or overwhelms.** One place to look, one card per question, no
  configuration needed to start.
- **Too little context to answer.** A card that sends you to the terminal to understand it has
  failed.
- **Doesn't work effectively.** A lost question, an answer that never reaches the seat, or a seat
  that doesn't resume.

## The experience

### `/live`: rest, then triage (nick chose this; the mockup is `question-card-v2`)

- **At rest:** a calm **"Waiting on you · N"** list. Each row shows the seat, its question in one
  line, what it is working on, and how long it has waited.
- **Triage:** **Answer all** or **⌘K** opens one full decision card at a time:
  - the seat, a **waiting · 2m** pill, and its lane, PR and branch;
  - **the question** in large type;
  - **why it is asking**, in the seat's own words, one or two lines;
  - **options**, each with a one-line consequence ("Fastest; merges on its own if it passes"),
    keyed 1–9;
  - a **free-text** box: "Or tell ryder something else…";
  - the **quick actions**;
  - keys: `1–9` answer, `S` skip, `esc` close.
  On answer: a small confirmation ("Sent to ryder — waking on musterd-joiner-1"), and the next card
  slides in.
- **Show more**, one tap: the seat's last few steps and the relevant diff or failure, without
  leaving the card.

### Phone

The same card as a **swipe stack**: tap an option, or type. Notification actions carry the options
plus a text-input action, so a one-tap answer never needs the app open.

**Proof (nick, 2026-10-30): lighter for questions only.** The paired phone signs a question's answer
silently with its device key, with no Face ID, so an answer works straight from the notification.
An answer to a seat's question is input to that seat, never a signature on a privileged act.
Privileged approvals keep ADR 676's Face ID path unchanged. This narrows ADR 676 decision 7 for
questions and goes in the exception ADR.

**Who builds it (fifty's call):** this project owns the wire and the server side. The phone screens
and notification actions are handed to cider as their own lanes, alongside Away channels 7
(`01M50XQ1TG`) and the "a settled ask's notifications clear" lane (`01M673P1E8`), which overlaps
"answering in one place clears it everywhere".

### Slack, then more

The same card in Block Kit: option buttons and a **Reply** that opens a text field. It picks up the
parked interactive-Slack lane (`01M0E02ZHA`, ADR 289). Later channels (email, Teams, Discord, SMS)
are adapters behind one interface; each declares whether it can carry buttons and free text.

### Quick actions (fifty's call: four fixed actions, no saved prompts)

| Action | What nick types today | What it does |
| --- | --- | --- |
| **Start** | "Good morning / afternoon" | Wakes the seat to orient (the orient skill) and take tier-1 asks. Also **Start everyone**. |
| **Check inbox** | "Check messages / acceptance requests" | Wakes the seat to read its inbox and act. Mostly redundant once answers wake seats (below). |
| **Check PR** | "Did the PR land?" | musterd checks the seat's lane PR itself (merged / CI red / open) and tells the seat. Also automatic, below. |
| **Resume** | "What were you last working on?" | Wakes the seat with its last lane, branch and seat memory, told to pick that work back up. |

Each action is a **deterministic behaviour**, not text a model has to interpret. They appear on
every channel.

**Make the buttons rarely needed** (**fifty's call**):
- Anything addressed to a seat wakes it, answers included. Today `accept`/`decline` do not ring or
  wake the asker.
- musterd watches each seat's lane PR and tells the seat when it merges or its CI goes red, with no
  seat-side watcher to forget.

### Notifications (nick: per person; the defaults are **fifty's call**)

Settings → You, built on the away-channel settings (presence gating, tier floors, quiet hours):
- per channel (phone, Slack, browser, email): on or off, and how loud;
- **default:** buzz when a question blocks a seat's work; otherwise a quiet badge or count; no
  phone buzz while you are active on `/live`;
- per seat: optional "always buzz" or "never buzz";
- quiet hours hold everything except blocking questions.

## How it works

### 1. Catching the question (fifty's call: explicit first, a fallback second)

- **Explicit:** the seat's MCP gains a tool to ask a person a question. It **returns at once**, and
  the seat ends its turn; no turn is held open waiting for a person (**fifty's call**). The tool
  takes options, each option's
  consequence, why it is asking, and its lane, PR and branch. Seats are told, in their role skill
  and wake packet, to use it whenever they need a person's input, instead of ending the turn on a
  question in chat.
- **Fallback:** the turn-end hooks look at the last assistant message:
  - Claude Code's Stop hook; OpenCode's `session.idle`; Grok's and Muse's Stop hooks;
  - for **headless wakes**, `musterd host` itself, since it holds the run's final output;
  - Codex has no Stop hook (SessionStart, PostToolUse and UserPromptSubmit only). Interactive Codex
    is covered by the explicit tool plus the host; how to catch interactive Codex turn ends is left
    to the builder.
  If the last message asks the person something, an ask is raised from it, marked **inferred**, so
  its context is thinner and the miss is visible.
- **"Waiting on you"** is a state derived from the open question: the seat shows waiting, not idle,
  on `/live` and in the roster.

### 2. The question on the wire

Today options exist only as lettered lines parsed out of the body (`askChoices`,
`packages/web/src/live/askPhrase.ts`). Structured fields are needed:
- options, each with a label and a one-line consequence;
- why the seat is asking;
- its context (lane, PR, branch);
- inferred vs explicit;
- whether it blocks the seat's work, which drives notification loudness.

This is a protocol change: **ADR first** (hard rule 1).

**A new kind of ask, with no timeout (fifty's call).** A question does not inherit the 3/5/15-minute
tier contract, because the seat has already ended its turn. It stays open until one of these:
- it is answered;
- the seat withdraws it (the seat moved on, or decided itself);
- the seat's lane closes, which closes it automatically.
An answer that arrives after a withdrawal is delivered marked as late, so the seat can ignore it.

**Who may answer (nick, 2026-10-30):** by default, only the person the question is addressed to.
The seat may instead address a question to "anyone on the team" when it asks. Routing, notification
targeting and "clears everywhere" all follow the addressee.

### 3. The answer, and the security exception

- An answer is an option, free text, or both. It is recorded against the question, wakes the asking
  seat on the immediate lane, and clears the card on every channel.
- **Delivery path (fifty's call):**
  - A seat that is **idle in an open session** (a terminal or tmux on the laptop) gets the answer
    through the existing idle-wake doorbell injectors (ADR 558: the Claude Code messaging socket, the
    Codex queue, the OpenCode ring, the Grok leader).
  - A **headless** seat, such as one on the box, gets it through a host resume wake
    (`claude --resume` and the equivalents).
  - If the session **cannot be resumed** (the transcript cap, a capture miss), a fresh session gets a
    daemon-composed recap: the seat's own question quoted back to it, plus the answer. The exception
    ADR covers that narrow case too. The quoted text is the same seat's own words, never another
    agent's.
- **ADR 088 §4 today:** a wake carries a pointer, never a message body, so text from another agent
  can never be injected as instructions. That stays the rule for everything else.
- **The exception (its own ADR):** a person's **verified** answer to **that seat's own question**
  enters the session verbatim, fenced and labelled as that person's answer. "Verified" per channel:
  - `/live`: the person's signed-in session;
  - phone: the paired device's signature, silent for questions (ADR 676 / ADR 759, narrowed above);
  - Slack: a Slack account linked to that musterd member and checked on every interaction.
  Free text needs this stronger proof than a button tap. Today channel answers count only as
  advisory (ADR 618).
- **Delivery is confirmed:** the seat acknowledges that it received the answer. An answer that does
  not reach the seat within a window is retried, then shown on the card as undelivered. It is never
  silently lost.

### 4. Quick actions on the wire

Each action is a typed request to a seat, from a person, that wakes it with a deterministic,
daemon-composed instruction. This follows ADR 088 §4's pointer rule; no free text is involved.
- **Check PR** and the automatic PR watch read the lane's PR state through the **hub's** `gh`, so no
  new GitHub credentials are needed (**fifty's call**). Where no `gh` login is available, the seat and
  the card say so; it never fails silently.
- **Resume** composes the seat's lane, branch and memory into the wake.

## Constraints

- **Security:** no free-text path that a non-person or an unverified identity can drive into a
  session. Every answer and action is audited with its channel and identity. Seats keep ADR 662's
  rules: an answer is input to a seat, never a signature on a privileged act.
- **Works wherever the seat runs:** the laptop, `musterd-joiner-1`, a Fly cloud seat, and later a
  hosted team.
- **No configuration to start:** the defaults work for a new user.
- **Build on what works:** wake leases, the host's resume path, the doorbell, the away-channel
  settings, phone pairing. Replace any UI that does not meet the bar. nick explicitly allowed
  discarding existing designs, including the experimental chat bar (`PromptBar.tsx` behind
  `?promptbar=1`).
- **Coordinate, do not collide** with cider's mobile ask redesign (`01M65FXGN1`) and Away channels
  7 (`01M50XQ1TG`).

## Success measures

Tracked from day one (**fifty's call**):
- **Lost questions:** zero. Every question the fallback catches that was not raised explicitly is
  counted, with a target that falls over time.
- **Answer to resume:** time from the answer to the seat acting on it. Target p50 under 30 s, both on
  the laptop and on the box.
- **Answered without the terminal:** the share of questions answered from a card. Target: most of
  them.
- **Undelivered answers:** zero left unflagged.
- **nick's own signal:** how often he opens a seat terminal in a day. It should fall to the
  occasional deep dive.

## Phasing (fifty's call; order can change)

1. **The loop on `/live` and the phone:**
   - explicit question tool and structured fields (ADR);
   - answer wakes the seat, with the verified-answer exception (ADR);
   - "waiting on you";
   - the `/live` list and triage;
   - phone card with notification actions and text input.
2. **Quick actions and the automatic wakes:** answers ring and wake; PR merge and CI-red events go to
   the seat.
3. **The fallback catcher** in the turn-end hooks and the host.
4. **Slack.**
5. **More channels** behind the adapter interface.

## Left to the builder

- The exact tool name and wire field names; the inferred-question heuristic; how interactive Codex
  turn ends are caught.
- The recap's exact composition when a session cannot be resumed.
- Visual detail past the v2 mockup: motion, sound, empty states, the "show more" layout. All of it
  is held to nick's bar.
- The retry and undelivered windows; batching for seats that ask too often.
- How the triage view composes with the existing `AsksStrip` and the doorbell sinks.

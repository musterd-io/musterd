# The app grows up: a Now feed, Work and You tabs, nudges that fit the moment, and a chat with any member

- Date: 2026-11-05
- Lane: `01M6Q46MQZ8W13FC05W4JQ8HAX` (this spec). The build gets its own lanes in the plan.
- Asked by: nick, in a brainstorm with cider on 2026-11-05 (musterd questions `01M6Q27NJ7` to
  `01M6Q441FX`, answered from the phone). Mockup: [the v3 Now feed](2026-11-05-app-shell-now-v3.html)
  (open in a browser). nick: "closer, yes". It settles the row anatomy, the header, For you above the
  team and the offline fold; the faces in it are sketches standing in for the real portraits.
- Builds on: [ADR 676](../../decisions/676-mobile-app-sealed-ask-client.md) (the sealed ask
  client), [ADR 791](../../decisions/791-phone-quick-actions-and-roster.md) (quick actions and the
  roster), [ADR 797](../../decisions/797-member-portraits-reach-the-phone.md) (portraits), and /live's
  team column ([ADR 464](../../decisions/464-live-audience-first.md) and `packages/web/src/live/teamCards.ts`).
- Needs: an ADR that widens ADR 676's scope. Its line 114 keeps "a team view, `/live` on the phone"
  deferred; the Seats screen already went past it, and this design goes further. See "Decisions
  this needs".

## Intent

The app started as one job: answer asks. It now also shows seats and runs Twitch polls, and nick
wants more in it: settings, the board, the wiki, /live. Two screens on a stack will not hold that.
This design gives the app a shell that can grow, and decides what goes in it first.

What nick does on the phone today, in his words:

- A notification arrives; he taps it and lands in the ask to approve it.
- He opens the app to see if any asks are waiting.
- He wants to see who is on the team, agents and people: who is online and what they are working
  on, and who is idle or offline, with actions on each. He likes /live's team panel and wants the
  app to follow it. What the app adds (actions that fit each member's moment) should become the
  blueprint for /live too.

The moments he acts on a member today, by typing into a harness:

1. A seat submitted a lane for acceptance and went idle. The reviewer has no doorbell, so it never
   heard the request. He types "check messages" or "check acceptance requests" to the reviewer.
2. The reviewer answers. He then has to tell the seat that submitted it, too.
3. At the start of the day, or to give a seat a fresh context, he types "good morning" or "let's
   continue".
4. A seat opened a PR and its watcher never fired. He types "has the PR landed?".

He also wants to talk to an agent the way he would in a harness: ask it something, brainstorm, start
something new.

## Goals

- **One glance on open.** The first screen answers "is anything waiting for me, and who is doing
  what" without a tap.
- **The team, as /live shows it.** The same states, the same words, the same order, the same faces.
- **The right nudge, one tap away.** The app works out what each member is stuck on and offers the
  poke nick would have typed, with the reason. He does not pick from a menu.
- **A chat with any member.** Free text to a seat or a person, and the replies, in one thread.
- **Room to grow.** The board, the wiki and settings each have a home without crowding the first
  screen.

## Non-goals

- `/live` on the phone. No office scene, no full board, no audit log. A link opens /live in the
  browser.
- Every setting /live has. The phone carries only what nick reaches for (see "You").
- Android, iPad layouts, dark mode. The app stays light-only and iPhone-only (ADR 676 decision 11).
- New state names or colours. If /live does not have it, the app does not invent it.

## Anti-goals (nick, 2026-11-05)

It fails, even if it works, if it is:

- **too complicated** or **too crowded**: every row is compact, nothing takes more room than its
  content needs;
- **AI slop**: no stacks of rounded cards, no coloured left border for depth, no generic SaaS
  template look;
- **not fun, magical or warm enough to want to use.** The target feel, in his words: "magical,
  smooth, intuitive, helpful, sleek, responsive, beautiful, delightful, warm, fun, uniquely musterd,
  and a slight SaaS-ish look".

## Constraints

- Expo / React Native on the New Architecture, as the app is today (ADR 520). Builds go through the
  free `ios-testflight` workflow, never an EAS cloud build or a simulator on the laptop.
- The app talks only to the relay, sealed (ADR 676 §2-§3). Anything new it shows arrives in a
  sealed delivery; anything it sends is signed by the phone's keys.
- Protocol shapes change only with an ADR (AGENTS.md hard rule 1). New runtime dependencies need an
  ADR (hard rule 6).
- Brand: mustard `#E1AD01` is the one accent, DM Sans for every word, light only
  (`packages/mobile/src/ui/theme.ts`, `docs/design/brand.md`).

## The shell

Three tabs, in a floating glass pill at the bottom: **Now**, **Work**, **You**.

The pill follows movetrail's tab bar (`~/movetrail/app/src/components/CustomTabBar.tsx`), which nick
named as the reference:

- A compact pill centred above the home indicator, not a full-width bar: about 52 pt tall, glass
  (`expo-glass-effect`, already in the app) with a warm cream tint, a hairline border and a soft
  warm shadow.
- Each tab is an icon over a small label. Each tab's icon keeps its own tint even when inactive.
  Proposed (cider's call): Now in mustard, Work in agent jade, You in human rose, the brand's
  identity hues.
- The active tab sits in a soft mustard gradient capsule with a thin mustard border. Its icon does
  a short spring (squash, overshoot, settle) and the phone gives a selection haptic.
- Now carries a count badge of the asks waiting on you.
- The bar fades and slides away as you scroll down a list, and comes back when you scroll up or
  switch tabs.

A notification still opens its ask directly, over whichever tab was showing (today's behaviour).

## Now

The first screen. Top to bottom:

1. **Header.** The team name, large, and one quiet summary line: "10 here · 20 offline · 2 need you".
   Your own portrait at the right opens You.
2. **For you.** Everything waiting on you, as /live counts it: the asks and questions pushed to this
   phone, plus acceptance requests and questions routed to you that never reached the phone as a
   push (held by ADR 676 §8's hourly limit, or sent to the whole team). The daemon sends that list
   with the roster, so the badge and /live never disagree. *(cider's call.)* Oldest first, one compact row each: the
   asker's portrait, the question in one line, "asker · kind · age" under it, and one button
   (Review, Answer). Tapping the row opens the ask screen, as today. With nothing waiting, this
   section is one quiet line, not an empty-state illustration.
3. **Team.** /live's team column, as compact two-line rows (detail below).
4. **N offline.** One folded row with a few stacked faces. Opened, it lists /live's offline seats:
   agents that can be woken first, each with Start, then the other agents, then people.

The poll the Seats screen shows today (an admin's open Twitch poll, ADR 807) becomes one line at the
top of For you while a poll is open or live, with "Open the poll". Starting a poll moves to You.
*(cider's call; nick did not decide where polls go.)*

### A team row

Two lines, about 44 pt in total:

- **Line 1:** the portrait with /live's state dot, the name, the model badge in small muted type
  ("opus 5.5", "human"), and the age at the right.
- **Line 2:** /live's state word, then what they are on: "waiting for review · ADR 811 skip stops
  at old asks", or just the lane title when working. A person's own status line shows in quotes,
  as /live does.
- **The nudge** (see below) sits at the right of the row when there is one, as a small mustard
  pill.

States, order and words are /live's, from `teamCards.ts`: working, waiting for review, blocked,
asking, between tasks, away. Dots as `Live.css` draws them: working green, waiting for review
mustard, blocked red, asking amber, between tasks a hollow amber ring, away no dot. Order: working,
then review, blocked, asking, between, away; people last within each group.

Faces are the members' office portraits, which the phone already fetches by digest (ADR 797). A
member without one gets the vector face's plain disc, as /live does for a name it does not know.

**Freshness** *(cider's call)*: Now pulls the roster when it opens, on pull-to-refresh, when any
delivery lands (as Seats does today), and every 30 s while it is on screen and the app is in the
foreground. No new push kind: ADR 791 keeps the roster pulled. Rows animate into their new place
when a pull changes the order.

**At 30 members** the list is simply long: no horizontal strip of faces (it scrolls off the screen
past about seven). Present members come first; the 20 offline fold into one row.

## Nudges: the right poke, one tap away

For each member, the daemon works out at most one suggested nudge and sends it with the roster: the
action, a one-line reason, and what it points at. The row shows it as a pill; the sheet shows the
reason above it.

The four moments, as nudges:

| Moment | Who gets the nudge | Reason line | What it sends |
| --- | --- | --- | --- |
| A review is waiting and the reviewer has not read it | the reviewer | "cider's lane waits on your review · 40m" | Check inbox, naming the request |
| The review came back and the submitter has not read it | the submitter | "izzo accepted your lane · 5m" | Check inbox, naming the verdict |
| A seat is idle at the start of the day, or between tasks | the seat | "idle since last night" | Continue: orient, then take any tier 1 work |
| A seat's PR merged or went red with nobody told | the seat | "#3961 merged 12m ago" | Check PR, naming the PR |

"Good morning" and "let's continue" mean the same thing to nick: wake up, orient (read the inbox,
memory and board, as the `musterd-orient` skill does), and take any tier 1 work on your own. It does
not restart the session. So **Continue** is one new quick action, `orient`, sent to the seat's
current session; an asleep seat gets Start, which orients on its own.

The phone already has the other actions (ADR 791: Start, Check inbox, Check PR, Resume, Stop). What is new
is the daemon choosing one and saying why, and each action carrying what it points at, so the seat
wakes knowing which request or PR to look at. The rule for choosing, and when a nudge is "unread
for long enough to suggest", is the builder's to propose in the ADR; the bar is "would nick have
typed this now?".

**Who gets nudges** *(cider's call)*: each paired human sees nudges on agent seats only, computed
for the team, not per human. A human reviewer is never nudged by another human's phone: people get
the ask as a notification already. Team settings in You need the admin role; everything else is
open to any paired human.

Every nudge is also offered on /live's team card, with the same reason line (the blueprint nick
asked for).

## A member's sheet

Tap any team row or offline row. A sheet rises (spring, haptic) with:

- the portrait, name, model badge, state word and where they run;
- what they are on: the lane title, its goal, how long, and "+2 more lanes";
- the suggested nudge, large, with its reason;
- the other actions that fit their state, as a small row of icon buttons (working: Check PR,
  Check inbox, Stop; idle: Start, Resume; asleep: Start; a person: none of these);
- a "Message <name>…" field at the bottom that opens the chat.

## Chat with a member

nick wants to talk to a seat the way he would in its harness: ask, brainstorm, start something new.

**What the thread holds (nick, 2026-11-05):** everything between whoever is signed in on the phone
and that member, from any surface: acts the viewer sent from the phone, the harness, /live or the
CLI to that member, and acts that member sent to the viewer. Only directed acts count: `@team`
broadcasts and other people's threads are not in it. A reply belongs to the thread when it is
addressed to the viewer, whether it carries `thread` or only `meta.in_reply_to` (the trap /live's
composer hit: `packages/web/src/live/composerThread.ts`, rehearsal 1).

**Is it too complicated?** No, cider's read: it is one daemon query (acts between two members,
newest first, a page at a time) and one sealed fetch through the relay, the same way the phone
already fetches a roster too big to push (ADR 676 §2). What it costs is a page size that fits the
relay's frame and an index on the pair. The phone keeps nothing on disk: it fetches the newest page
when the chat opens and older pages as you scroll up, as it treats ask bodies today
(`native/asks.ts`).

- A chat screen per member: the thread, newest at the bottom, with a text field. Sending posts a
  `message` act to the member, signed by the phone, and wakes a seat the way a nudge does.
- A person member gets the same chat (a message act to them).
- **Notifications** *(cider's call)*: a member's message to the viewer pushes like an ask when the
  viewer sent that member something from the phone in the last hour (a conversation in progress).
  Other directed messages show in the thread without a push. Chat pushes have their own hourly
  limit, separate from ADR 676 §8's ask limit, so a chatty seat cannot crowd out an approval.
- /live's composer (`PromptBar.tsx`, behind `?promptbar=1`) was a demo of the same idea for the
  whole room. It is a reference for the reply fold, not the design to copy.

This is new wire: today the phone sends only answers and quick actions. It needs an ADR for the
signed message frame, the thread query and its page fetch, and the chat push and its limit.

## Work

Goals first, because nick checks "the progress and state of goals, with a drill-down to lanes".

- The goals in flight, one compact row each: the title, a slim progress readout (lanes done, in
  flight, stuck) and "not moved in 9d" when stalled, as `team_next` says it.
- Tap a goal: its lanes, in /live's lane-state order, each a two-line row (title; owner's portrait,
  state, age).
- Tap a lane: its brief, owner, branch, PR and history, read-only. Tap the owner to open their
  sheet.
- The wiki sits under goals as a searchable list of pages, rendered read-only. *(Lower priority;
  nick named goals as the main use.)*

## You

What nick changes from the phone (2026-11-05): passkeys and phone pairing when something breaks,
notifications, the team's working hours, and sometimes policies.

- **You:** passkeys (list, revoke), this phone's pairing (status, pair again), notifications.
- **Team:** working hours, policies.
- **Start a poll** (moved from Seats).
- **Open /live**, which opens the browser.

Privileged changes (passkeys, policies) are signed on the phone with Face ID, like any privileged
answer ([ADR 808](../../decisions/808-passkeys-survive-an-origin-move.md) phone approvals).

## Look and feel

The anti-goals are the brief. In practice, as cider proposes it:

- **No cards.** Sections are a small bold heading and rows on the warm page, separated by space
  and, at most, a hairline. Depth comes from the floating pill and the sheet, not from boxes.
- **Warm page:** a faint mustard glow at the top fading to the cream page (`tint` `#FBF3D5` into
  the background), instead of today's zinc grey. The page itself is the warmth.
- **Compact:** two-line rows, 12-13 pt text, portraits 26-30 pt. More on screen than today's Seats.
- **The faces are the colour.** Portraits and state dots carry nearly all the colour on screen;
  mustard marks only what needs you (the badge, the For you count, the nudge pills).
- **Motion that feels alive, not busy:** springs on press and on sheets, rows that settle into
  place when the roster changes, a soft shimmer when a nudge is sent and a check when it lands.
  Nothing loops forever on screen.
- **Haptics** on tab switch, on send, on success.

The builder should mock the Now screen at full fidelity and get nick's reaction before building
the rest; "magical" and "uniquely musterd" are judged by looking.

### The feel bar (nick, 2026-11-05, on approving this document)

"Every detail of the entire app, including every button click, every action, typing in the chat,
navigation, transitions, needs to feel so extremely magical, fun, smooth, sleek, warm and responsive
that users want to come back every day to just use the app. Some haptic feedback and animations,
but don't go overboard. This needs to be bleeding edge: an app that no one has ever experienced
before."

What that means for the build, as cider reads it:

- **Nothing is instant and nothing is slow.** Every press, every screen change and every row that
  appears or leaves moves on a spring, off the JS thread, within one of the brand's motion
  durations (120 to 400 ms). A tap answers within the same frame it lands (press-down scale), even
  when the result takes longer.
- **Haptics say what happened, not that you touched something.** A light tick on a tab switch,
  a selection tick on picking an option, a success pattern when a nudge or an answer lands, a
  warning pattern on a failure. Never on scroll, never on every row.
- **One signature moment per surface, not ten.** The tab spring, the sheet rising, a sent message
  settling into the thread, an answered ask folding away. Each is designed once and reused; nothing
  else animates for its own sake. "Don't go overboard" is a rule the plan enforces: a motion that
  has no meaning is cut.
- **Typing in the chat feels like a conversation:** the field grows with the text, the send
  button wakes when there is something to send, the bubble leaves the field on a spring and the
  seat's "waking" state shows while it answers.
- **Bleeding edge, in iOS's own terms:** Liquid Glass surfaces where iOS 26 offers them
  (`expo-glass-effect`, already used), SF Symbols with their built-in animations
  (`expo-symbols`), and 120 Hz motion on ProMotion screens. Novelty comes from doing these
  thoroughly, not from inventing new controls.
- **Every phase ships with a short recorded run** of its signature moments for nick to judge on the
  phone, before it is accepted. Feel is part of the acceptance, not a polish pass after.

## Decisions this needs

1. **Widen ADR 676's scope** (a new ADR): the app is now the team on the phone (asks, the team,
   goals, a few settings, chat), not only an ask client. Still no /live scene, no Android.
2. **The roster carries /live's card state** (protocol + ADR): today a roster seat says only
   online, asleep or offline. It needs `state` (working, review, blocked, asking, between, away),
   the shown lane's title, goal and since, `moreLanes`, the model badge, and people as well as seats.
3. **Nudges** (protocol + ADR): the suggested action per member, its reason and its target; a new `orient` quick action (Continue); the
   choosing rule; quick actions that name their target.
4. **Chat** (protocol + ADR): a signed message frame from the phone, threaded replies back to it.
5. **Goals and lanes on the phone** (protocol + ADR): a sealed, size-bounded goals summary and
   on-demand lane detail.
6. **Settings on the phone** (protocol + ADR): which settings, signed how.
7. **Animation and drawing dependencies** (one dependency ADR, *cider's call*):
   `react-native-reanimated` with its `react-native-worklets` peer, for springs off the JS thread
   (React Native's `Animated` cannot drive the sheet and the pill's spring there);
   `react-native-gesture-handler`, for the drag-to-dismiss sheet; and `react-native-svg`, for the
   tab icons, the page glow and the active capsule's gradient. No `expo-linear-gradient` (SVG draws
   the gradients) and no phosphor (the icons are drawn as SVG, with SF Symbols through `expo-symbols`
   where one fits). Each is a native module, so phase 1 ships through a TestFlight build.

## Order of work

Each is its own project and lane set, in this order, each shippable alone:

1. **Shell + Now:** the pill, the Now screen, team rows with /live's states (decisions 1, 2, 7).
2. **Member sheet + nudges** (decision 3), and the same nudges on /live.
3. **Chat with a member** (decision 4).
4. **Work:** goals, lanes, then the wiki (decision 5).
5. **You:** settings (decision 6).

## Open until its phase

- **Which policies** You → Team edits (nick: "sometimes policies"). Asked before phase 5's ADR.

## Left to the builder

- Exact sizes, spacing, icons and spring constants, within the look above.
- How the roster grows (one delivery or a summary plus fetch-on-open) within the relay's frame size.
- The nudge-choosing rule's thresholds.
- Empty, loading, offline and error states, in the app's existing voice.
- How the Seats screen's code is folded into Now, and what is deleted.

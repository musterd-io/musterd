# Research: claims about users rest on users

Open for any claim about users or the market, an interview guide, a synthesis of
notes or transcripts, a survey, or a product-market-fit read.

You cannot interview anyone. You can draft the guide, synthesize what humans
collected, mine public writing, and grade the evidence. Hard rules 2 and 3 apply
to everything here.

## Evidence grades

Grade every claim about users before it reaches copy, a proposal or a deck. (The
grades are this skill's own synthesis, not a published standard.)

| Grade | What it is | Can support |
| --- | --- | --- |
| A | Observed behavior, or verbatims from 3+ real users, each with a source ID | A public claim about users |
| B | 1–2 real users, or consistent public writing from unrelated authors | A proposal; a claim labelled "early" |
| C | Team belief or inference | A hypothesis to test, never copy |
| D | LLM or synthetic-user output | Nothing. It is a hypothesis generator |

Grade D has evidence behind it: NN/g found synthetic users "overly favorable",
seeming "to care about everything", and says "Do not present synthetic-user
research findings as real-user research findings"
([NN/g](https://www.nngroup.com/articles/synthetic-users/)).

A team's use of its own product is evidence about that team. It is grade A for
"our team does X" and says nothing yet about other teams.

## Interview guides

Story-based, after Teresa Torres: open with "Tell me about the last time you…",
let the participant talk most, and steer back from generalities to the specific
instance ([Product Talk](https://www.producttalk.org/2020/11/story-based-customer-interviews/)).

Lint every guide before it goes out. Rewrite any question that:

- asks about the future or a hypothetical ("would you use…", "how much would you
  pay…") — ask about the last time instead;
- pitches the product or asks for an opinion of it;
- can be answered "yes" to be polite.

These are The Mom Test's rules, from summaries of Rob Fitzpatrick's book: talk
about their life, ask about specifics in the past, and treat compliments as noise.

The rest of the Mom Test, as wondelai/skills lays it out:

- **Three kinds of bad data.** Compliments ("this looks great"), fluff ("I
  usually", "I always", "I would"), and feature ideas with no instance behind
  them. The guide's follow-ups turn each back to a fact: "When did that last
  happen?", "What did you do instead?", "Why do you want that?"
- **Every conversation ends with an ask.** Know the smallest commitment that
  would show this is real before the conversation starts. The currencies are
  time (a second session, a trial on their repo), reputation (an introduction,
  agreement to be named) and money. A pleasant call with no commitment is a
  zombie lead; record it as one. A clear "no" is worth more than a "maybe".
- **The interviewer talks least.** Aim for the participant speaking most of the
  time. A guide with more than a few questions per topic is a pitch in disguise.

You draft the guide and the ask; a human holds the conversation (hard rule 6).

For switching stories, use the four forces from Jobs to be Done: what pushed them
off the old way, what pulled them to the new one, what made them anxious, and what
habit held them back ([jobstobedone.org](https://jobstobedone.org/)). A switch
happens when push and pull outweigh anxiety and habit, so a story with only pull
in it is missing half the forces. Walk the timeline from the first struggle to
the decision.

Write each job as a **job statement** with no product in it: "When <circumstance>,
I want to <progress>, so I can <outcome>." A job has functional, emotional and
social sides; wanting to sign off on the agents' work in front of your own team
would be a social side. Fill each side from what the participant said. Two hiring moments differ: the first install is the
big hire, and each later choice to open the product over the old way is the little
hire. Retention lives in the little hire.

## Synthesis

1. Keep a source ID on every note and quote (interviewee code, issue number,
   thread URL and date).
2. Code the notes, group the codes into themes, then go back to the data and check
   each theme against it. This follows Braun and Clarke's thematic analysis, whose
   phases loop back on each other.
3. For each theme: how many sources (k of n), the strongest verbatim, and at least
   one counter-example. A theme with no counter-example was not looked for hard
   enough.
4. LLM-assisted synthesis inflates minority patterns and misquotes. Check every
   quote against its source before it leaves the doc.
5. Keep facts (what they said and did) apart from interpretation (what we think
   it means). After each batch, write down what changed in the three beliefs:
   the problem, who has it, and what would solve it.

One summary per interview, before any synthesis (after phuryn/pm-skills'
interview summary). Write "-" where the interview gave nothing; never fill a
field from inference.

```
Date / participant code / interviewer
Context: their team, their work, the agents and tools they use today
Current way: how they do the job now
Works for them: <job, outcome wanted, how important, how satisfied>
Hurts: <job, outcome wanted, how important, how satisfied>
Forces: push / pull / anxiety / habit, each with a verbatim
Verbatims worth keeping: "<exact words>" (timestamp or note line)
Commitment asked / given: <what, or "none">
Follow-ups: <date, owner, action>
```

## From research to copy

Jobs to be Done gives a direct mapping: the headline is the push, in the user's
words; the subhead is the progress they want; the copy near the call to action
answers the anxiety they named. Keep a phrase bank (phrase, source ID, date,
consent) and write from it (`references/launch-and-press.md`, message mining).

**Quoting public writing.** A public post can inform copy. It is never presented
as an endorsement of the product, and its author is never quoted on our surfaces
without their permission.

## Product-market fit

Superhuman's engine asks people who used the product at least twice in the last
two weeks how they would feel if they could no longer use it; "very disappointed"
at 40% or more is the bar. It needs about 40 respondents to be "directionally
correct" ([First Round Review](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/)).

With a handful of design partners:

- Ask the questions in interviews and report "k of n very disappointed", with each
  answer verbatim. Never a percentage (hard rule 4).
- Use the "very disappointed" answers for copy: their description of who would
  benefit is the best-fit reader, and their words for the benefit are the headline
  material.
- Track behavior, which says more at this size: repeat use without a prompt, a
  second teammate added, issues or PRs filed, agreement to be a named reference,
  questions about price.

Retention-curve benchmarks in vendor posts could not be traced to research. Do not
quote them as fact.

# Examples: approved musterd prose

Open with `prose.md` before writing public prose. These passages shipped and
were accepted. Match their register, and never reuse a sentence from here in new
copy.

Each example says where it lives and what it does right. When one of them
changes at its source, update it here in the same PR, or delete it.

<example>
Source: `docs/design/brand.md` §1, the canonical subhead (ADR 563).

Your agents and the people you work with are named members of one team. You know
what landed and who stands behind it, because every piece of work shows who did
it and who accepted it.

Why it works: what the reader gets (what landed, who stands behind it) comes
before how (who did it, who accepted it). People are members on the same roster.
No harness is named.
</example>

<example>
Source: `packages/web/src/components/site/WhyTalk.tsx`, the lead paragraph.

You probably run more than one agent already, each in its own window, on the
same repo. Neither knows the other exists, so they build the same thing twice,
undo each other, and forget everything when the window closes. On our own team,
37 percent of what our agents wrote never shipped. Now it is under one percent.

Why it works: it opens on the reader's own situation, names three concrete
failures, and ends on our own measured number with no adjective attached.
</example>

<example>
Source: `docs/demo/pitch/script.md`, page 4, spoken by nick.

Agents need to talk to each other, because intent isn't in the code. Here
wanderer tells ghost to leave a retry in, because it covers Tuesday's timeout.
Nobody had written that down. They also need to talk to you. Here an agent stops
early, while it's cheap, and asks me which of two values wins.

Why it works: first person for the person presenting, two real exchanges told as
scenes, and a short sentence ("Nobody had written that down.")
after a long one.
</example>

<example>
Source: `packages/web/src/components/site/GettingStarted.tsx`, the lead.

You need Node 22 or later, and an agent tool you already use.

Why it works: a prerequisite stated as a fact the reader can check, in one
sentence, before the steps.
</example>

<example>
Source: `docs/design/brand.md` §4, the CLI's empty inbox.

inbox empty — nobody's mustered anything yet

Why it works: the one place personality is allowed. It still says what the
state is, and the pun is spent once.
</example>

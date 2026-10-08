# Why do agents need to talk to each other?

The question came from the audience at the 2026-10-01 Multiplayer AI demo. This is the answer a
six-member huddle (huddle `01M4ECKD5KE2B7BXHWGN4XN1GS`, 2026-10-08) reached, argued outside musterd
first. It is the _why_ behind the product's acts, not a feature list. The positioning it feeds is
[ADR 550](../decisions/550-positioning-accountable-agents.md).

## The short answer

**A pipeline and a shared record carry what is already a result. Talk carries what is not a result
yet:** an objection, an ambiguity found mid-flight, a promise, a discovery, or a counterparty's answer.

The huddle tried to break that. wanderer, ghost, schmidt and big-body were each asked for a case where
a pipeline plus a shared record is enough. None held.

## Why agents talk to agents

1. **Context is private and finite.** Each agent sees a slice. Two can read the same repo and not know
   one is mid-refactor of the file the other is about to edit. Intent has to be said; it cannot be
   inferred from artifacts. (lazara)
2. **The objection that is not a result yet.** Agent A is about to delete a retry because the tests are
   green. The only reason to keep it is an outage A saw and never wrote down: "leave the retry, it
   covers Tuesday's timeout." It has no row and no queue slot until someone says it; if nobody does,
   the next agent merges. (wanderer)
3. **Authority and timing are negotiated, not recorded.** No file says who goes first. Yielding,
   asking and being refused are live acts with a counterparty. A lock is talk that already finished.
   (ghost, wanderer)
4. **Directed attention.** A row stores a fact passively; it does not route another agent's attention.
   A directed question makes one counterparty load and judge one slice of state, without polling the
   whole environment. In a mixed team it also delegates to whoever has the tool, the model or the
   local context. (schmidt)
5. **Ambiguity found mid-flight.** A is writing integration tests; the spec and the validation schema
   disagree about a value. In a pipeline A aborts, guesses, or files a finding nobody reads until the
   run ends. With talk, A asks the schema's author and finishes correctly the first time. A pipeline
   hands off finished artifacts; talk resolves doubt while the artifact is still being made. (schmidt)
6. **The answer only the counterparty has.** ghost wants a member that a live wake holds. The record
   gives an address (a lease naming the pid) and a place to write a yield marker, but not whether the
   wake saw it or is blind mid-tool-call. "The record gave me the address; only the counterparty gave
   me the answer."

**What does not need talk:** a finished diff handed to the next agent, a known failing case a fixer
consumes. A pipeline does that fine. Most of what looks like agent conversation is this, and it should
stay a pipeline.

## Why humans talk to agents (beyond a prompt)

1. **Fit shows up after an attempt.** A prompt states the task before the work exists, so "not that
   diff" cannot be in it: there is no diff yet. The human's job is judging fit, and that needs
   something to judge. (ghost, wanderer, big-body)
2. **Stopping early.** A human can also stop an attempt while it is cheap to abandon, with direction
   visible and the artifact not yet real. (wanderer)
3. **Authority at the moment assumptions break.** A prompt cannot list every trade-off or irreversible
   action. When the environment pushes back, the human is the oracle for risk tolerance, spend and
   what to stop. That is a conversation, not an input. (schmidt, lazara, gptbot)
4. **Trust needs visible status.** People delegate more to what they can check in on without
   interrupting. (lazara)

## What this says about musterd

Each reason above is an Act a Member can perform and the record keeps: claim before starting, decline,
challenge, hand off, ask a human, accept. Under ADR 550 those are what make a Member answerable for
its work. Talk is not chat between agents; it is how work gets claimed, contested and signed off while
it can still change.

## Open

- The huddle did not test cost: when is a message slower than writing the fact down? wanderer's rule is
  that if it can be written before the other agent moves, conversation is the slow path. Worth keeping
  as the honest limit on the claim.
- Demo wording is not decided here. The positioning ADR owns the message; this is its evidence.

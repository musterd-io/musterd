//
//  logic-check.swift
//
//  A macOS executable for the Foundation-only half of the extension: route JSON, the seen-nonce
//  rule, and the lock-screen copy. It is not part of either Xcode target. Run it with the three
//  sources it checks:
//
//    swiftc -o /tmp/nse-logic-check \
//      ios/extension/RouteJson.swift ios/extension/SeenNonce.swift ios/extension/Notice.swift \
//      ios/extension/PinBinding.swift ios/extension/AskRoutes.swift ios/extension/Readable.swift \
//      ios/extension/Question.swift logic-check.swift
//    /tmp/nse-logic-check
//
//  A multi-file swiftc invocation has no top-level entry unless one file is named main.swift,
//  so the checks live in `@main`. Keychain, HPKE and the enclave are not exercised here.
//

import Foundation

func check(_ ok: Bool, _ message: String) {
  if !ok {
    fputs("FAIL \(message)\n", stderr)
    exit(1)
  }
}

@main
enum LogicCheck {
  static func main() {
    run()
  }
}

private func run() {
let fixture = RouteFields(
  team: "revive",
  binding: "bind-1",
  ref: "ask-9f3k",
  expiresAt: 4_102_444_800_000
)
check(
  RouteJson.canonical(fixture)
    == "{\"binding\":\"bind-1\",\"expires_at\":4102444800000,\"ref\":\"ask-9f3k\",\"team\":\"revive\"}",
  "route fixture"
)

let quoted = RouteJson.canonical(
  RouteFields(team: "rev\"ive", binding: "b", ref: "r", expiresAt: 1)
)
check(
  quoted == "{\"binding\":\"b\",\"expires_at\":1,\"ref\":\"r\",\"team\":\"rev\\\"ive\"}",
  "route escaping"
)

let fresh = SeenNonce.consume(records: [], key: "n", expiresAt: 100, now: 50)
check(fresh.verdict == .fresh && fresh.records.count == 1, "fresh inserts")
let replay = SeenNonce.consume(records: fresh.records, key: "n", expiresAt: 100, now: 50)
check(replay.verdict == .replay && replay.records.count == 1, "replay does not reinsert")
let expired = SeenNonce.consume(records: [], key: "n", expiresAt: 40, now: 50)
check(expired.verdict == .expired && expired.records.isEmpty, "expired does not insert")
let pruned = SeenNonce.consume(
  records: [SeenNonce.Record(key: "old", expiresAt: 10)],
  key: "n",
  expiresAt: 100,
  now: 50
)
check(pruned.records.count == 1 && pruned.records[0].key == "n", "dead records are pruned")

let ask = Notice.Body.ask(
  text: "Ship it?",
  from: "wallow",
  actionClass: "advisory",
  hasApproval: false,
  waiting: 2,
  nonce: "n"
)
check(Notice.gate(body: ask, routeExpiresAt: 10, now: 10) == .stale, "route expiry is not consumed")
check(Notice.gate(body: ask, routeExpiresAt: 20, now: 10) == .open, "a live ask is open")
let empty = Notice.Body.ask(text: "", from: "wallow", actionClass: "advisory", hasApproval: false, waiting: 0, nonce: "n")
check(Notice.gate(body: empty, routeExpiresAt: 20, now: 10) == .unverified, "empty body")

check(PinBinding.matches(stored: nil, route: "bind-1"), "a pin with no binding accepts the route")
check(PinBinding.matches(stored: "bind-1", route: "bind-1"), "the stored binding matches itself")
check(!PinBinding.matches(stored: "bind-1", route: "other"), "a different binding is refused")

let waitingPin =
  "{\"v\":1,\"identity\":\"abc\",\"receive\":\"def\",\"relay\":\"https://relay.example\",\"team\":\"revive\"}"
let filled = PinBinding.withBinding(json: waitingPin, routeBinding: "bind-1")
check(filled != nil, "the first verified route fills the binding")
let filledObject = filled.flatMap {
  try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
}
check(filledObject?["binding"] as? String == "bind-1", "filled binding")
check(filledObject?["team"] as? String == "revive", "filled pin keeps the team")
if let filled {
  check(PinBinding.withBinding(json: filled, routeBinding: "other") == nil, "a stored binding is not replaced")
  check(PinBinding.withBinding(json: filled, routeBinding: "bind-1") == filled, "the same binding is kept")
}
check(PinBinding.withBinding(json: waitingPin, routeBinding: "") == nil, "an empty binding is refused")
let longBinding = String(repeating: "x", count: 65)
check(PinBinding.withBinding(json: waitingPin, routeBinding: longBinding) == nil, "a long binding is refused")

let shown = Notice.render(body: ask, verdict: .fresh)
check(shown.body == "Ship it?" && shown.category == Notice.advisoryCategory, "advisory actions")
check(shown.title == "wallow", "the asker is the title")
let long = Notice.Body.ask(text: String(repeating: "word ", count: 60), from: "wallow", actionClass: "advisory", hasApproval: false, waiting: 0, nonce: "n")
check(!(Notice.render(body: long, verdict: .fresh).body.hasSuffix("…")), "an answerable ask is never cut")
check(shown.subtitle == "\(Notice.answerHint) · 2 more waiting" && shown.sound, "waiting subtitle")

let listed = Notice.Body.ask(
  text: "Ship it?",
  from: "wallow",
  actionClass: "privileged",
  hasApproval: false,
  waiting: 0,
  nonce: "n"
)
check(Notice.render(body: listed, verdict: .fresh).category == nil, "a listed act has no actions")
let withApproval = Notice.Body.ask(
  text: "Ship it?",
  from: "wallow",
  actionClass: "advisory",
  hasApproval: true,
  waiting: 1,
  nonce: "n"
)
let approved = Notice.render(body: withApproval, verdict: .fresh)
check(approved.category == nil && approved.subtitle == "1 more waiting", "approval has no actions")

let stale = Notice.render(body: ask, verdict: .replay)
check(stale.body == Notice.staleText && stale.category == nil && !stale.sound, "replay is stale")
check(Notice.render(body: .held(count: 1), verdict: .fresh).body == "1 ask is held.", "one held")
check(Notice.render(body: .held(count: 3), verdict: .fresh).body == "3 asks are held.", "many held")
check(Notice.render(body: .paired(member: "nick", deviceKeyId: "k"), verdict: .fresh).body == "Paired as nick.", "paired")
check(Notice.seenKey(body: ask, ref: "ref") == "n", "an ask is keyed by its nonce")
check(Notice.seenKey(body: .held(count: 1), ref: "ref") == "ref", "a summary is keyed by its ref")

// ADR 772: the phone's own list of the asks that reached it.
let a = AskRoutes.Record(team: "t", binding: "b", ref: "a", expiresAt: 100, seen: false)
let one = AskRoutes.record(records: [], adding: a, now: 50)
check(one == [a], "an admitted ask is recorded unseen")
let seenA = AskRoutes.markSeen(records: one, refs: ["a"], now: 50)
check(seenA.first?.seen == true, "the list marks it seen")
var again = a
again.expiresAt = 200
let repushed = AskRoutes.record(records: seenA, adding: again, now: 60)
check(repushed.count == 1 && repushed[0].seen && repushed[0].expiresAt == 200,
  "a re-push keeps seen and takes the later expiry")
check(AskRoutes.record(records: seenA, adding: a, now: 150).isEmpty, "expired is pruned, not added")
check(AskRoutes.forget(records: repushed, refs: ["a"], now: 60).isEmpty, "a gone ask is forgotten")
let many = (0..<60).reduce([AskRoutes.Record]()) { list, i in
  AskRoutes.record(records: list,
    adding: AskRoutes.Record(team: "t", binding: "b", ref: "r\(i)", expiresAt: 1000, seen: false),
    now: 0)
}
check(many.count == AskRoutes.cap && many.first?.ref == "r10", "the newest fifty are kept")
check(AskRoutes.decode(AskRoutes.encode(repushed)!) == repushed, "records round-trip")
check(AskRoutes.decode(Data("[{\"ref\":1}]".utf8)) == nil, "a bad record fails the read")

// The lock screen's text: the same fixtures as src/native/readable.test.ts.
let readable: [(String, String, String)] = [
  (
    "[lane] acceptance requested for `01M653W2N4GNXM0STPSZYH2NEE`: **merge it?**\n\n- tests pass\n- docs updated",
    "acceptance requested for 01M653W2N4: merge it? • tests pass • docs updated",
    "acceptance requested for 01M653W2N4: merge it? • tests pass • docs updated"
  ),
  (
    "Can I run the hub migration on the shared daemon now? It restarts it for about 30 seconds, and every live session reconnects on its own afterwards without anyone doing anything.",
    "Can I run the hub migration on the shared daemon now? It restarts it for about 30 seconds, and every live session reconnects on its own afterwards without anyone doing anything.",
    "Can I run the hub migration on the shared daemon now?"
  ),
  (
    "## Deploy\nShip build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the glass pass",
    "Deploy Ship build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the glass pass",
    "Deploy Ship build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the…"
  ),
]
for (input, plain, summary) in readable {
  check(Readable.plain(input) == plain, "plain: \(Readable.plain(input))")
  check(Readable.summary(input, max: 120) == summary, "summary: \(Readable.summary(input, max: 120))")
}

// ADR 773/774: a question answered from the lock screen. The same fixture as questionKey.test.ts.
let questionText = "ship \"it\"\nafter\tlunch 🚀 a/b \u{2028} \u{7f} \\ é"
check(
  Question.signingBytes(team: "revive", binding: "bind-1", ask: "q1", token: "t1", nonce: "n1",
    choice: 2, text: questionText)
    == "musterd-app-question-answer/v1\nrevive\nbind-1\nq1\nt1\nn1\n2\n\"ship \\\"it\\\"\\nafter\\tlunch 🚀 a/b \u{2028} \u{7f} \\\\ é\"",
  "question signing bytes match JSON.stringify"
)
check(
  Question.signingBytes(team: "revive", binding: "bind-1", ask: "q1", token: "t1", nonce: "n1",
    choice: 0, text: nil) == "musterd-app-question-answer/v1\nrevive\nbind-1\nq1\nt1\nn1\n0\n-",
  "a choice alone"
)
check(
  Question.signingBytes(team: "t", binding: "b", ask: "a", token: "k", nonce: "n", choice: nil,
    text: nil) == nil, "nothing to answer with signs nothing")
check(Question.choice(action: "musterd.question.choice.2") == 2, "third button")
check(Question.choice(action: "musterd.question.choice.3") == nil, "only three buttons")
check(Question.choice(action: "musterd.answer.approve") == nil, "approve is not an option")
check(Question.replyText("  ok \n") == "ok", "a reply is trimmed")
check(Question.replyText(" \n ") == nil, "an empty reply is not sent")
check(Question.replyText(String(repeating: "x", count: 4001)) == nil, "a reply past the wire's limit")

let pendingQ = Question.Pending(team: "t", binding: "b", ref: "q", expiresAt: 100, token: "k",
  nonce: "n", options: 2)
let qs = Question.record([], adding: pendingQ, now: 50)
check(Question.find(qs, ref: "q", now: 50) == pendingQ, "an admitted question is found")
check(Question.find(qs, ref: "q", now: 100) == nil, "an expired question is not")
var fresher = pendingQ
fresher.token = "k2"
check(Question.record(qs, adding: fresher, now: 50) == [fresher], "a re-delivery replaces the token")
check(Question.forget(qs, ref: "q", now: 50).isEmpty, "an answered question is forgotten")
check(Question.decode(Question.encode(qs)!) == qs, "questions round-trip")

let q = Question.Info(text: "Which **branch**?", options: ["main", "next"], token: "k")
let question = Notice.Body.ask(text: "Which branch?", from: "ryder · agent", actionClass: "advisory",
  hasApproval: false, waiting: 0, nonce: "nq", question: q, quiet: false)
let answerable = Notice.render(body: question, verdict: .fresh, questionKey: true)
check(answerable.category == Question.optionsCategory(nonce: "nq"), "a question with options")
check(answerable.body == "Which branch?" && answerable.subtitle == Notice.answerHint, "question copy")
check(answerable.category != Notice.advisoryCategory, "a question is never approve or decline")
let noKey = Notice.render(body: question, verdict: .fresh)
check(noKey.category == nil && noKey.subtitle == nil, "no question key: the tap opens the app")
let open = Notice.Body.ask(text: "Why?", from: "ryder", actionClass: "advisory", hasApproval: false,
  waiting: 0, nonce: "n2", question: Question.Info(text: "Why?", options: [], token: "k"), quiet: true)
let openShown = Notice.render(body: open, verdict: .fresh, questionKey: true)
check(openShown.category == Question.replyCategory, "no options: Reply only")
check(openShown.passive && !openShown.sound, "a passive question lands quietly")
let blankQ = Notice.Body.ask(text: "x", from: "r", actionClass: "advisory", hasApproval: false,
  waiting: 0, nonce: "n", question: Question.Info(text: "", options: [], token: "k"))
check(Notice.gate(body: blankQ, routeExpiresAt: 20, now: 10) == .unverified, "a blank question")

fputs("ok\n", stdout)
}

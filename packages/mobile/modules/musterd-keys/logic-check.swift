//
//  logic-check.swift
//
//  A macOS executable for the Foundation-only half of the extension: route JSON, the seen-nonce
//  rule, and the lock-screen copy. It is not part of either Xcode target. Run it with the three
//  sources it checks:
//
//    swiftc -o /tmp/nse-logic-check \
//      ios/extension/RouteJson.swift ios/extension/SeenNonce.swift ios/extension/Notice.swift \
//      logic-check.swift
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
  actionClass: "advisory",
  hasApproval: false,
  waiting: 2,
  nonce: "n"
)
check(Notice.gate(body: ask, routeExpiresAt: 10, now: 10) == .stale, "route expiry is not consumed")
check(Notice.gate(body: ask, routeExpiresAt: 20, now: 10) == .open, "a live ask is open")
let empty = Notice.Body.ask(text: "", actionClass: "advisory", hasApproval: false, waiting: 0, nonce: "n")
check(Notice.gate(body: empty, routeExpiresAt: 20, now: 10) == .unverified, "empty body")

let shown = Notice.render(body: ask, verdict: .fresh)
check(shown.body == "Ship it?" && shown.category == Notice.advisoryCategory, "advisory actions")
check(shown.subtitle == "2 more waiting" && shown.sound, "waiting subtitle")

let listed = Notice.Body.ask(
  text: "Ship it?",
  actionClass: "privileged",
  hasApproval: false,
  waiting: 0,
  nonce: "n"
)
check(Notice.render(body: listed, verdict: .fresh).category == nil, "a listed act has no actions")
let withApproval = Notice.Body.ask(
  text: "Ship it?",
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
check(Notice.render(body: .paired(member: "nick"), verdict: .fresh).body == "Paired as nick.", "paired")
check(Notice.seenKey(body: ask, ref: "ref") == "n", "an ask is keyed by its nonce")
check(Notice.seenKey(body: .held(count: 1), ref: "ref") == "ref", "a summary is keyed by its ref")

fputs("ok\n", stdout)
}

//
//  Question.swift
//  MusterdKeys
//
//  The pure half of answering a question from the lock screen (ADR 773/774). A question is answered
//  with one of its options or a typed reply, signed by the silent question key, so the action needs
//  no Face ID and no app launch. Spec for the signed bytes: `appQuestionAnswerSigningBytes` in
//  `@musterd/protocol` appChannel.ts; `logic-check.swift` pins them against a JS fixture.
//
//  The extension writes one `Pending` record per question it admitted: what the action handler in
//  the app needs to answer it without opening the seal again. It holds the delivery's token, which
//  redeems nothing without a signature from this phone's question key.
//

import Foundation

enum Question {
  /// A question with no options: Reply only. Registered by the app with the advisory category.
  static let replyCategory = "musterd.question"
  /// A question with options gets its own category, registered by the extension, because an
  /// action's title is fixed when its category is registered.
  static let optionsCategoryPrefix = "musterd.question.options."
  static let actionChoicePrefix = "musterd.question.choice."
  static let actionReply = "musterd.question.reply"
  static let replyTitle = "Reply"
  static let replySend = "Send"
  static let replyPlaceholder = "Your answer"
  /// The first three options become buttons; the rest are answered in the app or by Reply.
  static let maxButtons = 3
  static let maxOptions = 9
  static let labelMax = 80
  static let answerTextMax = 4000

  /// What a delivery says about its question: the text, the option labels, and the token an
  /// answer redeems.
  struct Info: Equatable {
    var text: String
    var options: [String]
    var token: String
  }

  static func optionsCategory(nonce: String) -> String {
    optionsCategoryPrefix + nonce
  }

  /// The option an action identifier picks, or nil for anything that is not an option button.
  static func choice(action: String) -> Int? {
    guard action.hasPrefix(actionChoicePrefix),
      let index = Int(action.dropFirst(actionChoicePrefix.count)),
      index >= 0, index < maxButtons
    else { return nil }
    return index
  }

  /// A typed reply as the wire takes it: trimmed, non-empty, at most `answerTextMax` characters.
  static func replyText(_ raw: String) -> String? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.utf16.count <= answerTextMax else { return nil }
    return text
  }

  /// `appQuestionAnswerSigningBytes`: the domain tag, the route, and the answer, one per line.
  /// `text` is last and JSON-quoted. Nil when there is nothing to answer with.
  static func signingBytes(
    team: String,
    binding: String,
    ask: String,
    token: String,
    nonce: String,
    choice: Int?,
    text: String?
  ) -> String? {
    if choice == nil && text == nil { return nil }
    let textLine: String
    if let text {
      guard let quoted = RouteJson.jsonString(text) else { return nil }
      textLine = quoted
    } else {
      textLine = "-"
    }
    return [
      "musterd-app-question-answer/v1",
      team,
      binding,
      ask,
      token,
      nonce,
      choice.map(String.init) ?? "-",
      textLine,
    ].joined(separator: "\n")
  }

  /// One question the extension admitted.
  struct Pending: Equatable {
    var team: String
    var binding: String
    var ref: String
    var expiresAt: Int
    var token: String
    var nonce: String
    var options: Int
  }

  static let cap = 50

  /// A re-delivery of the same question replaces its record: its token is the live one.
  static func record(_ records: [Pending], adding pending: Pending, now: Int) -> [Pending] {
    var live = prune(records, now: now).filter { $0.ref != pending.ref }
    if pending.expiresAt > now { live.append(pending) }
    return Array(live.suffix(cap))
  }

  static func find(_ records: [Pending], ref: String, now: Int) -> Pending? {
    prune(records, now: now).last { $0.ref == ref }
  }

  static func forget(_ records: [Pending], ref: String, now: Int) -> [Pending] {
    prune(records, now: now).filter { $0.ref != ref }
  }

  static func prune(_ records: [Pending], now: Int) -> [Pending] {
    records.filter { $0.expiresAt > now }
  }

  static func encode(_ records: [Pending]) -> Data? {
    let array = records.map {
      [
        "team": $0.team, "binding": $0.binding, "ref": $0.ref, "expires_at": $0.expiresAt,
        "token": $0.token, "nonce": $0.nonce, "options": $0.options,
      ] as [String: Any]
    }
    return try? JSONSerialization.data(withJSONObject: array)
  }

  static func decode(_ data: Data) -> [Pending] {
    guard let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return []
    }
    return array.compactMap { item in
      guard let team = item["team"] as? String,
        let binding = item["binding"] as? String,
        let ref = item["ref"] as? String,
        let expiresAt = (item["expires_at"] as? NSNumber)?.intValue,
        let token = item["token"] as? String,
        let nonce = item["nonce"] as? String,
        let options = (item["options"] as? NSNumber)?.intValue
      else { return nil }
      return Pending(team: team, binding: binding, ref: ref, expiresAt: expiresAt, token: token,
        nonce: nonce, options: options)
    }
  }
}

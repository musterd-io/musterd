//
//  Notice.swift
//  MusterdKeys
//
//  The lock-screen copy (ADR 676 decisions 3, 7 and 8). Spec: `src/native/notice.ts`.
//  The sentences are pinned by `swift-drift.test.ts`. A listed act gets no category, so the
//  notification has no actions and the tap only opens the app.
//

import Foundation

enum Notice {
  static let title = "musterd"
  /// The lock screen's fallback when a check refuses (ADR 777). Which check is never said here.
  static let unverifiedText = "New ask — open musterd to see it."
  static let staleText = "This ask is no longer available."
  static let answerHint = "Press and hold to answer"
  static let advisoryCategory = "musterd.ask.advisory"
  static let actionApprove = "musterd.answer.approve"
  static let actionReject = "musterd.answer.reject"

  enum Body {
    /// `question` is set on a question ask (ADR 773); `quiet` when the daemon says it lands
    /// without a buzz (`interruption: passive`).
    case ask(
      text: String, from: String, actionClass: String, hasApproval: Bool, waiting: Int,
      nonce: String, question: Question.Info? = nil, quiet: Bool = false)
    case held(count: Int)
    case paired(member: String, deviceKeyId: String)
  }

  /// Before the nonce store is written. A route expiry or an undrawable body is not consumed.
  enum Gate {
    case open
    case stale
    case unverified
  }

  struct Rendered {
    var title: String
    var body: String
    var subtitle: String?
    var category: String?
    var sound: Bool
    /// Delivered at `.passive`: into Notification Center without lighting the screen.
    var passive: Bool = false
  }

  static func gate(body: Body, routeExpiresAt: Int, now: Int) -> Gate {
    if routeExpiresAt <= now { return .stale }
    switch body {
    case .ask(let text, _, _, _, _, _, let question, _):
      if text.isEmpty || question?.text.isEmpty == true { return .unverified }
    case .paired(let member, _):
      if member.isEmpty { return .unverified }
    case .held:
      break
    }
    return .open
  }

  static func seenKey(body: Body, ref: String) -> String {
    switch body {
    case .ask(_, _, _, _, _, let nonce, _, _):
      return nonce
    case .held, .paired:
      return ref
    }
  }

  /// `questionKey`: this binding has an enrolled question key, so a question can be answered from
  /// the notification itself. Without one, a question only opens the app.
  static func render(body: Body, verdict: SeenNonce.Verdict, questionKey: Bool = false) -> Rendered {
    if verdict != .fresh { return stale() }
    switch body {
    case .ask(_, let from, _, _, _, let nonce, let question?, let quiet):
      if question.text.isEmpty { return unverified() }
      // A question is never approved or declined (ADR 773): its actions are its options and Reply.
      let category =
        questionKey
        ? (question.options.isEmpty ? Question.replyCategory : Question.optionsCategory(nonce: nonce))
        : nil
      return Rendered(
        title: from,
        body: category == nil ? Readable.summary(question.text, max: 180) : Readable.plain(question.text),
        subtitle: category == nil ? nil : answerHint,
        category: category,
        sound: !quiet,
        passive: quiet
      )
    case .ask(let text, let from, let actionClass, let hasApproval, let waiting, _, nil, _):
      if text.isEmpty { return unverified() }
      let category = actionClass == "advisory" && !hasApproval ? advisoryCategory : nil
      let more = waitingSubtitle(waiting)
      // Lock-screen actions only show on a press and hold (nick, 2026-10-29).
      let subtitle = category == nil ? more : more.map { "\(answerHint) · \($0)" } ?? answerHint
      // Who is asking is the title; the text is cleaned and cut at a sentence (nick, 2026-10-30:
      // "a tiny bit too much raw text dump"). An ask answerable from here is never cut: the whole
      // text is what the answer is about. The app's ask screen has the whole text either way.
      return Rendered(
        title: from,
        body: category == nil ? Readable.summary(text, max: 180) : Readable.plain(text),
        subtitle: subtitle,
        category: category,
        sound: true
      )
    case .held(let count):
      let body = count == 1 ? "1 ask is held." : "\(count) asks are held."
      return Rendered(title: title, body: body, subtitle: nil, category: nil, sound: true)
    case .paired(let member, _):
      if member.isEmpty { return unverified() }
      return Rendered(
        title: title,
        body: "Paired as \(member).",
        subtitle: nil,
        category: nil,
        sound: true
      )
    }
  }

  static func unverified() -> Rendered {
    Rendered(title: title, body: unverifiedText, subtitle: nil, category: nil, sound: false)
  }

  static func stale() -> Rendered {
    Rendered(title: title, body: staleText, subtitle: nil, category: nil, sound: false)
  }

  private static func waitingSubtitle(_ waiting: Int) -> String? {
    if waiting == 1 { return "1 more waiting" }
    if waiting > 1 { return "\(waiting) more waiting" }
    return nil
  }
}

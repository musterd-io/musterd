//
//  AskCategory.swift
//  MusterdKeys
//
//  The app's fixed categories. The advisory one: `authenticationRequired` makes the action itself
//  ask for Face ID; `foreground` opens the app, where the enclave signature asks again (ADR 676
//  decision 7). Decline is destructive as well. A listed act has no category, so it has no actions.
//  A question with no options gets Reply only (ADR 774 §5); a question with options gets a category
//  of its own from the extension (`QuestionCategory`), kept here while its question is live.
//

import UserNotifications

enum AskCategory {
  static func register() {
    let approve = UNNotificationAction(
      identifier: Notice.actionApprove,
      title: "Approve",
      options: [.authenticationRequired, .foreground]
    )
    let decline = UNNotificationAction(
      identifier: Notice.actionReject,
      title: "Decline",
      options: [.authenticationRequired, .destructive, .foreground]
    )
    let advisory = UNNotificationCategory(
      identifier: Notice.advisoryCategory,
      actions: [approve, decline],
      intentIdentifiers: [],
      options: []
    )
    let now = Int(Date().timeIntervalSince1970 * 1000)
    Task {
      await QuestionCategory.register(
        [advisory, QuestionCategory.reply()],
        liveNonces: QuestionCategory.liveNonces(now: now)
      )
    }
  }
}

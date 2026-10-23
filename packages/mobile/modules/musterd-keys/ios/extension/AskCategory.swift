//
//  AskCategory.swift
//  MusterdKeys
//
//  The advisory category, registered by the app. A notification service extension cannot
//  register categories, and it cannot present Face ID. `authenticationRequired` makes the
//  action itself ask for Face ID; `foreground` opens the app, where the enclave signature
//  asks again (ADR 676 decision 7). Decline is destructive as well. A listed act has no
//  category, so it has no actions.
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
    let category = UNNotificationCategory(
      identifier: Notice.advisoryCategory,
      actions: [approve, decline],
      intentIdentifiers: [],
      options: []
    )
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }
}

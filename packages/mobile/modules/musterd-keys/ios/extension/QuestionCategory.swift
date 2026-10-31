//
//  QuestionCategory.swift
//  MusterdKeys
//
//  A question's notification actions (ADR 773/774): its first three options as buttons, and Reply.
//  None of them asks for Face ID or opens the app — the silent question key signs the answer in the
//  background — so a question can be answered with the phone locked. An action's title is fixed
//  when its category is registered, so a question with options gets a category of its own,
//  registered by the extension just before it hands the notification over.
//
//  `setNotificationCategories` replaces the whole set, so every caller keeps the others: the
//  app's fixed categories, and each per-question one whose question is still live.
//

import UserNotifications

enum QuestionCategory {
  static func reply() -> UNNotificationCategory {
    UNNotificationCategory(
      identifier: Question.replyCategory,
      actions: [replyAction()],
      intentIdentifiers: [],
      options: []
    )
  }

  static func options(nonce: String, labels: [String]) -> UNNotificationCategory {
    let buttons = labels.prefix(Question.maxButtons).enumerated().map { index, label in
      UNNotificationAction(identifier: "\(Question.actionChoicePrefix)\(index)", title: label, options: [])
    }
    return UNNotificationCategory(
      identifier: Question.optionsCategory(nonce: nonce),
      actions: buttons + [replyAction()],
      intentIdentifiers: [],
      options: []
    )
  }

  private static func replyAction() -> UNTextInputNotificationAction {
    UNTextInputNotificationAction(
      identifier: Question.actionReply,
      title: Question.replyTitle,
      options: [],
      textInputButtonTitle: Question.replySend,
      textInputPlaceholder: Question.replyPlaceholder
    )
  }

  /// Register `adding` beside what is already registered. A per-question category whose nonce is
  /// not in `liveNonces` is dropped, so the set does not grow without end.
  static func register(_ adding: [UNNotificationCategory], liveNonces: Set<String>) async {
    let center = UNUserNotificationCenter.current()
    let existing = await center.notificationCategories()
    let replaced = Set(adding.map(\.identifier))
    var next = existing.filter { category in
      if replaced.contains(category.identifier) { return false }
      guard category.identifier.hasPrefix(Question.optionsCategoryPrefix) else { return true }
      return liveNonces.contains(String(category.identifier.dropFirst(Question.optionsCategoryPrefix.count)))
    }
    next.formUnion(adding)
    center.setNotificationCategories(next)
    // The set is applied asynchronously; reading it back waits for it, so the notification handed
    // over next already finds its category.
    _ = await center.notificationCategories()
  }

  /// The nonces of the questions still waiting on this phone.
  static func liveNonces(now: Int) -> Set<String> {
    Set(Question.prune(SharedStore.loadQuestions(), now: now).map(\.nonce))
  }
}

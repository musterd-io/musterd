//
//  MusterdPushSubscriber.swift
//  MusterdKeys
//
//  App-side notification registration (ADR 676 decisions 7 and 11). The extension cannot
//  register categories or receive the device token, so this subscriber does both. It is not
//  compiled into the extension.
//
//  The APNs entitlement is production (TestFlight only). A Debug build asks Apple for a
//  development token against that entitlement and registration fails; that is accepted,
//  because this app is not run as a local debug install.
//
//  Approve and Decline carry `authenticationRequired` and `foreground`. The action's Face ID
//  is the system's; the enclave signature in the app is a second one. The response is kept
//  until JavaScript calls `takePendingAnswer`, because the app may still be launching.
//

import ExpoModulesCore
import UIKit
import UserNotifications

enum PendingAnswers {
  struct Pending {
    var action: String
    var userInfoJSON: String
  }

  private static let lock = NSLock()
  private static var pending: Pending?
  static weak var emitter: MusterdKeysModule?

  static func store(action: String, userInfo: [AnyHashable: Any]) {
    let json = jsonText(userInfo) ?? userInfo["musterd"].flatMap(jsonText)
    guard let json else { return }
    lock.lock()
    pending = Pending(action: action, userInfoJSON: json)
    lock.unlock()
    DispatchQueue.main.async {
      emitter?.sendEvent("onPendingAnswer")
    }
  }

  static func take() -> Pending? {
    lock.lock()
    defer { lock.unlock() }
    let value = pending
    pending = nil
    return value
  }

  private static func jsonText(_ value: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value),
      let text = String(data: data, encoding: .utf8)
    else { return nil }
    return text
  }
}

/// The asks list's source on the phone (lane 7h): what the extension already admitted and left in
/// Notification Center, each with the `musterd` payload still carrying its route and inline seal.
/// The app opens them again in TypeScript; nothing here reads a seal.
enum DeliveredPushes {
  static func list() async -> [[String: Any]] {
    let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
    return delivered.compactMap { notification in
      let userInfo = notification.request.content.userInfo
      guard userInfo["musterd"] != nil,
        JSONSerialization.isValidJSONObject(userInfo),
        let data = try? JSONSerialization.data(withJSONObject: userInfo),
        let text = String(data: data, encoding: .utf8)
      else { return nil }
      return [
        "id": notification.request.identifier,
        "userInfo": text,
        "deliveredAt": Int(notification.date.timeIntervalSince1970 * 1000),
      ]
    }
  }

  /// Take every notification for these asks out of Notification Center: each is settled, so its
  /// notification only says something that is no longer true (nick, 2026-10-30).
  static func clear(refs: [String]) async {
    let settled = Set(refs)
    guard !settled.isEmpty else { return }
    let center = UNUserNotificationCenter.current()
    let ids = await center.deliveredNotifications().compactMap { notification in
      ref(notification.request.content.userInfo).map { settled.contains($0) } == true
        ? notification.request.identifier : nil
    }
    if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
  }

  /// The ask a push carries, by its ref; nil for anything that is not a musterd push.
  static func ref(_ userInfo: [AnyHashable: Any]) -> String? {
    (userInfo["musterd"] as? [String: Any])?["ref"] as? String
  }

  /// Tell a running app that a delivery landed, so an open list refreshes.
  static func announce(_ userInfo: [AnyHashable: Any]) {
    guard userInfo["musterd"] != nil else { return }
    DispatchQueue.main.async {
      PendingAnswers.emitter?.sendEvent("onDelivery")
    }
  }
}

public final class MusterdPushSubscriber: BaseExpoAppDelegateSubscriber,
  ExpoAppDelegateSubscriberProtocol,
  UNUserNotificationCenterDelegate
{
  public static weak var current: MusterdPushSubscriber?
  /// Strong: the center holds its delegate weakly, so a weak copy here would drop the
  /// previous delegate the moment we replace it and forwarding would never run.
  private static var previousDelegate: UNUserNotificationCenterDelegate?

  public required init() {
    super.init()
    Self.current = self
  }

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    Self.prepare(application)
    return true
  }

  public func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    #if DEBUG
      let environment = "development"
    #else
      let environment = "production"
    #endif
    SharedStore.savePushToken(token: token, environment: environment)
  }

  /// Kick registration again from JavaScript. Categories are replaced with the one this
  /// app owns; nothing else in the app registers a category.
  public static func prepare(_ application: UIApplication) {
    current?.installDelegate()
    AskCategory.register()
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .badge, .sound, .timeSensitive]
    ) { _, _ in
      DispatchQueue.main.async {
        application.registerForRemoteNotifications()
      }
    }
  }

  private func installDelegate() {
    let center = UNUserNotificationCenter.current()
    if let delegate = center.delegate, delegate !== self {
      Self.previousDelegate = delegate
    }
    center.delegate = self
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    DeliveredPushes.announce(notification.request.content.userInfo)
    if Self.previousDelegate?.userNotificationCenter?(
      center,
      willPresent: notification,
      withCompletionHandler: completionHandler
    ) != nil {
      return
    }
    // Opening the app asks the daemon to re-push what is pending (ADR 676 decision 9). An ask
    // already in Notification Center is a repeat: it goes to the list without a banner or a
    // sound. A new ask alerts as usual (nick, 2026-10-29: opening the app re-alerted asks).
    guard let ref = DeliveredPushes.ref(notification.request.content.userInfo) else {
      completionHandler([.banner, .list, .sound])
      return
    }
    center.getDeliveredNotifications { delivered in
      let seen = delivered.contains { DeliveredPushes.ref($0.request.content.userInfo) == ref }
      completionHandler(seen ? [.list] : [.banner, .list, .sound])
    }
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let action = response.actionIdentifier
    // A plain tap is kept too, so the app opens the ask it was tapped for: the tap takes the
    // notification out of Notification Center, and with it the ask from the list (nick,
    // 2026-10-29).
    if action == Notice.actionApprove || action == Notice.actionReject
      || action == UNNotificationDefaultActionIdentifier
    {
      PendingAnswers.store(action: action, userInfo: response.notification.request.content.userInfo)
    }
    if Self.previousDelegate?.userNotificationCenter?(
      center,
      didReceive: response,
      withCompletionHandler: completionHandler
    ) != nil {
      return
    }
    completionHandler()
  }
}

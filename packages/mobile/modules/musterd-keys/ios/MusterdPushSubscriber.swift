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
    if Self.previousDelegate?.userNotificationCenter?(
      center,
      willPresent: notification,
      withCompletionHandler: completionHandler
    ) != nil {
      return
    }
    completionHandler([.banner, .list, .sound])
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let action = response.actionIdentifier
    if action == Notice.actionApprove || action == Notice.actionReject {
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

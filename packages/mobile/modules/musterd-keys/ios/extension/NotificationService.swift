//
//  NotificationService.swift
//  MusterdNotify
//
//  The notification service extension (ADR 676 decisions 3, 7 and 8). It runs for about
//  thirty seconds, with no UI and no biometry. It opens the seal, checks the daemon's
//  signature, drops a seen nonce or an expiry, and replaces the relay's placeholder.
//  Any failure shows "an ask could not be verified" with no actions. A replay or an expiry
//  shows "This ask is no longer available." — the extension cannot withdraw the alert, so
//  an empty body would bring the placeholder back.
//
//  The `musterd` userInfo is left in place. The action handler in the app opens that same
//  seal; the seen-nonce store blocks a second display, not the answer of the one on screen.
//
//  Compiled only into the extension target (`NOTIFICATION_EXTENSION`). The pod excludes
//  this file so the app does not also contain a second principal class.
//

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var delivered = false
  private var bestAttempt = UNMutableNotificationContent()

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    bestAttempt =
      (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    let userInfo = request.content.userInfo
    Task {
      let rendered = await Self.render(userInfo)
      self.finish(rendered)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let already = delivered
    delivered = true
    lock.unlock()
    guard !already else { return }
    Self.apply(Notice.unverified(), to: bestAttempt)
    contentHandler?(bestAttempt)
  }

  private func finish(_ rendered: Notice.Rendered) {
    lock.lock()
    let already = delivered
    delivered = true
    lock.unlock()
    guard !already else { return }
    Self.apply(rendered, to: bestAttempt)
    contentHandler?(bestAttempt)
  }

  /// The whole decision, off the main thread's budget. Never throws.
  private static func render(_ userInfo: [AnyHashable: Any]) async -> Notice.Rendered {
    guard let block = PushBlock.parse(userInfo), let pin = Pin.parse(SharedStore.loadPairingPin()) else {
      return Notice.unverified()
    }
    if pin.team != block.team || !PinBinding.matches(stored: pin.binding, route: block.binding) {
      return Notice.unverified()
    }

    let opened: (route: RouteFields, enc: String, ct: String)
    if let enc = block.enc, let ct = block.ct {
      opened = (block.route, enc, ct)
    } else if let fetched = await fetchBody(relay: pin.relay, block: block) {
      if fetched.route.team != pin.team
        || !PinBinding.matches(stored: pin.binding, route: fetched.route.binding)
      {
        return Notice.unverified()
      }
      opened = fetched
    } else {
      return Notice.unverified()
    }

    let body: Notice.Body
    do {
      body = try DeliveryOpen.open(
        enc: opened.enc,
        ct: opened.ct,
        route: opened.route,
        pinnedIdentity: pin.identity,
        now: Int(Date().timeIntervalSince1970 * 1000)
      )
    } catch DeliveryOpenError.expired {
      return Notice.stale()
    } catch {
      return Notice.unverified()
    }

    // The signature held for this route. Remember its binding the first time, and never replace one.
    if pin.binding == nil {
      guard let current = SharedStore.loadPairingPin(),
        let updated = PinBinding.withBinding(json: current, routeBinding: opened.route.binding)
      else { return Notice.unverified() }
      do {
        try SharedStore.savePairingPin(json: updated)
      } catch {
        return Notice.unverified()
      }
    }
    // The signed `paired` delivery is the one place the phone learns its device key id.
    if case .paired(_, let deviceKeyId) = body {
      guard let current = SharedStore.loadPairingPin(),
        let updated = PinBinding.withDeviceKey(json: current, deviceKeyId: deviceKeyId)
      else { return Notice.unverified() }
      if updated != current {
        do {
          try SharedStore.savePairingPin(json: updated)
        } catch {
          return Notice.unverified()
        }
      }
    }

    let now = Int(Date().timeIntervalSince1970 * 1000)
    switch Notice.gate(body: body, routeExpiresAt: opened.route.expiresAt, now: now) {
    case .stale:
      return Notice.stale()
    case .unverified:
      return Notice.unverified()
    case .open:
      break
    }

    guard let verdict = SharedStore.consumeNonce(
      key: Notice.seenKey(body: body, ref: opened.route.ref),
      expiresAt: opened.route.expiresAt,
      now: now
    ) else { return Notice.unverified() }
    // ADR 772: the app's list reads its own record of the asks that reached this phone, so a
    // notification can be cleared without the ask leaving the list. A failed write still shows.
    if case .ask = body, verdict == .fresh {
      let route = opened.route
      SharedStore.updateAskRoutes {
        AskRoutes.record(
          records: $0,
          adding: AskRoutes.Record(team: route.team, binding: route.binding, ref: route.ref,
            expiresAt: route.expiresAt, seen: false),
          now: now
        )
      }
    }
    return Notice.render(body: body, verdict: verdict)
  }

  static func apply(_ rendered: Notice.Rendered, to content: UNMutableNotificationContent) {
    content.title = rendered.title
    content.body = rendered.body
    content.subtitle = rendered.subtitle ?? ""
    content.categoryIdentifier = rendered.category ?? ""
    content.sound = rendered.sound ? .default : nil
  }

  private static func fetchBody(
    relay: String,
    block: PushBlock
  ) async -> (route: RouteFields, enc: String, ct: String)? {
    guard let url = bodyURL(relay: relay, block: block) else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: .ephemeral, delegate: RefuseRedirect(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      return nil
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let team = object["team"] as? String,
      let binding = object["binding"] as? String,
      let ref = object["ref"] as? String,
      let expires = jsonInt(object["expires_at"]),
      let sealed = object["sealed"] as? [String: Any],
      jsonInt(sealed["v"]) == 1,
      let enc = sealed["enc"] as? String, !enc.isEmpty,
      let ct = sealed["ct"] as? String, !ct.isEmpty
    else { return nil }
    return (RouteFields(team: team, binding: binding, ref: ref, expiresAt: expires), enc, ct)
  }

  private static func bodyURL(relay: String, block: PushBlock) -> URL? {
    guard let origin = URL(string: relay),
      origin.scheme == "https",
      origin.user == nil,
      origin.password == nil,
      origin.path.isEmpty || origin.path == "/",
      origin.query == nil,
      origin.fragment == nil,
      origin.host != nil,
      !block.team.contains("/"),
      !block.binding.contains("/"),
      !block.ref.contains("/")
    else { return nil }
    var components = URLComponents()
    components.scheme = origin.scheme
    components.host = origin.host
    components.port = origin.port
    components.path = "/app/\(block.team)/body/\(block.binding)/\(block.ref)"
    return components.url
  }

  private static func jsonInt(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let asInt = number.int64Value
    if number.doubleValue != Double(asInt) { return nil }
    return Int(asInt)
  }
}

/// The `musterd` dictionary on the push. `enc`/`ct` are absent when the phone must fetch.
private struct PushBlock {
  var team: String
  var binding: String
  var ref: String
  var expiresAt: Int
  var enc: String?
  var ct: String?

  var route: RouteFields {
    RouteFields(team: team, binding: binding, ref: ref, expiresAt: expiresAt)
  }

  static func parse(_ userInfo: [AnyHashable: Any]) -> PushBlock? {
    let raw = (userInfo["musterd"] as? [String: Any]) ?? (userInfo as? [String: Any])
    guard let block = raw,
      jsonInt(block["v"]) == 1,
      let team = nonEmpty(block["team"]), team.count <= 64,
      let binding = nonEmpty(block["binding"]), binding.count <= 64,
      let ref = nonEmpty(block["ref"]), ref.count <= 128,
      let expiresAt = jsonInt(block["expires_at"]), expiresAt >= 0
    else { return nil }
    if block["sealed"] == nil {
      return PushBlock(team: team, binding: binding, ref: ref, expiresAt: expiresAt, enc: nil, ct: nil)
    }
    guard let sealed = block["sealed"] as? [String: Any],
      jsonInt(sealed["v"]) == 1,
      let enc = nonEmpty(sealed["enc"]),
      let ct = nonEmpty(sealed["ct"])
    else { return nil }
    return PushBlock(team: team, binding: binding, ref: ref, expiresAt: expiresAt, enc: enc, ct: ct)
  }
}

/// The pairing pin. Pairing writes it; a missing or malformed pin fails closed.
private struct Pin {
  var identity: String
  var relay: String
  var team: String
  /// Nil until a verified delivery names the channel binding.
  var binding: String?

  static func parse(_ json: String?) -> Pin? {
    guard let json, let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      jsonInt(object["v"]) == 1,
      let identity = nonEmpty(object["identity"]),
      nonEmpty(object["receive"]) != nil,
      let relay = object["relay"] as? String, relay.hasPrefix("https://"), !relay.contains("@"),
      let team = nonEmpty(object["team"])
    else { return nil }
    let binding: String?
    if object["binding"] == nil {
      binding = nil
    } else if let text = nonEmpty(object["binding"]), text.count <= 64 {
      binding = text
    } else {
      return nil
    }
    return Pin(identity: identity, relay: relay, team: team, binding: binding)
  }
}

/// A redirect would send the ask route to another host. Refusing it completes the task
/// with the 3xx response, which the status check then drops.
private final class RefuseRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private func nonEmpty(_ value: Any?) -> String? {
  guard let text = value as? String, !text.isEmpty else { return nil }
  return text
}

private func jsonInt(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
    return nil
  }
  let asInt = number.int64Value
  if number.doubleValue != Double(asInt) { return nil }
  return Int(asInt)
}

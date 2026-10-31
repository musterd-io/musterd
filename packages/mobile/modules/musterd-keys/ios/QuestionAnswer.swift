//
//  QuestionAnswer.swift
//  MusterdKeys
//
//  A question answered from its notification (ADR 773/774): an option button or Reply. The action
//  has no `foreground` and no `authenticationRequired`, so iOS wakes the app in the background and
//  this runs with the phone still locked. It signs with the silent question key, seals to the
//  daemon, and POSTs through the relay — the same callback `answer.ts` sends — with no JavaScript.
//
//  What it answers comes from the extension's own record of the question (`Question.Pending`),
//  written after the extension verified the delivery. The relay refusing twice keeps the callback
//  in `question-outbox`, which the app re-sends on its next open, and says so with a notification.
//  App only: not compiled into the extension.
//

import Foundation
import UserNotifications

enum QuestionAnswer {
  static let undeliveredText =
    "Your answer hasn’t reached your team yet. Open musterd to send it again."

  /// Answer one question action. Never throws; whatever fails leaves the question open.
  static func handle(_ response: UNNotificationResponse) async {
    let action = response.actionIdentifier
    let userInfo = response.notification.request.content.userInfo
    let now = Int(Date().timeIntervalSince1970 * 1000)
    guard let ref = DeliveredPushes.ref(userInfo),
      let pending = Question.find(SharedStore.loadQuestions(), ref: ref, now: now),
      let pin = AnswerPin.load(), pin.team == pending.team, pin.binding == pending.binding
    else { return }

    var choice: Int?
    var text: String?
    if action == Question.actionReply {
      guard let typed = (response as? UNTextInputNotificationResponse)?.userText,
        let reply = Question.replyText(typed)
      else { return }
      text = reply
    } else if let picked = Question.choice(action: action), picked < pending.options {
      choice = picked
    } else {
      return
    }

    guard let outgoing = build(pending: pending, pin: pin, choice: choice, text: text) else { return }
    // Kept first: if iOS ends the background time mid-send, the next open still sends it.
    keep(outgoing)
    var sent = await post(outgoing)
    if !sent {
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      sent = await post(outgoing)
    }
    if sent {
      unkeep(ref: ref)
      settled(ref: ref, now: now)
    } else {
      await notifyUndelivered()
    }
  }

  /// Re-send what the relay did not take. Returns how many are still waiting.
  static func flush() async -> Int {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    var waiting: [[String: Any]] = []
    for item in SharedStore.loadQuestionOutbox() {
      guard let outgoing = Outgoing(item), outgoing.expiresAt > now else { continue }
      if await post(outgoing) {
        settled(ref: outgoing.ref, now: now)
      } else {
        waiting.append(item)
      }
    }
    SharedStore.saveQuestionOutbox(waiting)
    return waiting.count
  }

  struct Outgoing {
    var url: URL
    var body: Data
    var ref: String
    var expiresAt: Int

    init(url: URL, body: Data, ref: String, expiresAt: Int) {
      self.url = url
      self.body = body
      self.ref = ref
      self.expiresAt = expiresAt
    }

    init?(_ item: [String: Any]) {
      guard let url = (item["url"] as? String).flatMap(URL.init(string:)),
        let body = (item["body"] as? String)?.data(using: .utf8),
        let ref = item["ref"] as? String,
        let expiresAt = (item["expires_at"] as? NSNumber)?.intValue
      else { return nil }
      self.init(url: url, body: body, ref: ref, expiresAt: expiresAt)
    }

    var item: [String: Any] {
      [
        "url": url.absoluteString, "body": String(decoding: body, as: UTF8.self), "ref": ref,
        "expires_at": expiresAt,
      ]
    }
  }

  /// Sign, seal and wrap the answer as the relay's callback body. Nil on any failure.
  static func build(pending: Question.Pending, pin: AnswerPin, choice: Int?, text: String?)
    -> Outgoing?
  {
    guard let bytes = Question.signingBytes(
      team: pending.team, binding: pending.binding, ask: pending.ref, token: pending.token,
      nonce: pending.nonce, choice: choice, text: text),
      let signature = try? PhoneKeys.signQuestion(bytes)
    else { return nil }
    var answer: [String: Any] = [:]
    if let choice { answer["choice"] = choice }
    if let text { answer["text"] = text }
    let body: [String: Any] = [
      "v": 1, "token": pending.token, "answer": answer, "nonce": pending.nonce, "key": "question",
      "signature": signature,
    ]
    let route = RouteFields(
      team: pending.team, binding: pending.binding, ref: pending.ref, expiresAt: pending.expiresAt)
    guard let plaintext = try? JSONSerialization.data(withJSONObject: body),
      let routeJson = RouteJson.canonical(route),
      let sealed = try? PhoneKeys.seal(
        recipientPublic: pin.receive,
        plaintext: String(decoding: plaintext, as: UTF8.self),
        purpose: "answer",
        aad: PhoneKeys.b64url(Data(routeJson.utf8))),
      let url = callbackURL(relay: pin.relay, team: pending.team)
    else { return nil }
    let callback: [String: Any] = [
      "app": 1, "kind": "answer", "binding": pending.binding, "ref": pending.ref,
      "expires_at": pending.expiresAt, "sealed": ["v": 1, "enc": sealed.enc, "ct": sealed.ct],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: callback) else { return nil }
    return Outgoing(url: url, body: data, ref: pending.ref, expiresAt: pending.expiresAt)
  }

  /// `https://<relay>/app/<team>/callback`, never leaving the pin's origin.
  static func callbackURL(relay: String, team: String) -> URL? {
    guard let origin = URL(string: relay), origin.scheme == "https", origin.host != nil,
      origin.user == nil, origin.password == nil, origin.path.isEmpty || origin.path == "/",
      origin.query == nil, origin.fragment == nil, !team.isEmpty, !team.contains("/")
    else { return nil }
    var components = URLComponents()
    components.scheme = origin.scheme
    components.host = origin.host
    components.port = origin.port
    components.path = "/app/\(team)/callback"
    return components.url
  }

  /// The relay takes a callback with 202, the same rule as `outbox.ts`.
  private static func post(_ outgoing: Outgoing) async -> Bool {
    var request = URLRequest(url: outgoing.url)
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = outgoing.body
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    guard let (_, response) = try? await session.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 202
  }

  /// Answered: the question leaves the phone's lists and Notification Center.
  private static func settled(ref: String, now: Int) {
    SharedStore.updateQuestions { Question.forget($0, ref: ref, now: now) }
    SharedStore.updateAskRoutes { AskRoutes.forget(records: $0, refs: [ref], now: now) }
    Task { await DeliveredPushes.clear(refs: [ref]) }
  }

  private static func keep(_ outgoing: Outgoing) {
    let kept = SharedStore.loadQuestionOutbox().filter { ($0["ref"] as? String) != outgoing.ref }
    SharedStore.saveQuestionOutbox(kept + [outgoing.item])
  }

  private static func unkeep(ref: String) {
    SharedStore.saveQuestionOutbox(
      SharedStore.loadQuestionOutbox().filter { ($0["ref"] as? String) != ref })
  }

  private static func notifyUndelivered() async {
    let content = UNMutableNotificationContent()
    content.title = Notice.title
    content.body = undeliveredText
    let request = UNNotificationRequest(identifier: "musterd.question.undelivered", content: content,
      trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }
}

/// The pairing pin's fields an answer needs. A missing binding means pairing has not finished.
struct AnswerPin {
  var team: String
  var binding: String
  var relay: String
  var receive: String

  static func load() -> AnswerPin? {
    guard let json = SharedStore.loadPairingPin(), let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let team = object["team"] as? String, !team.isEmpty,
      let binding = object["binding"] as? String, !binding.isEmpty,
      let relay = object["relay"] as? String, relay.hasPrefix("https://"),
      let receive = object["receive"] as? String, !receive.isEmpty
    else { return nil }
    return AnswerPin(team: team, binding: binding, relay: relay, receive: receive)
  }
}

/// A redirect would send the answer to another host.
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
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

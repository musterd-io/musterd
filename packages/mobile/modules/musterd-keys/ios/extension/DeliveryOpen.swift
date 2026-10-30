//
//  DeliveryOpen.swift
//  MusterdKeys
//
//  The extension's copy of `src/native/delivery.ts` (ADR 676 decisions 3 and 8). The extension
//  cannot run JavaScript, so the same steps live here: open the seal, check the daemon's
//  Ed25519 signature over `musterd-app/v1 signed\n<route>\n<payload>`, parse the payload, and
//  separate "expired" from "unverified". A failure never says which check refused.
//
//  The parse is the subset the lock screen needs, and it fails closed on a payload that is
//  not that shape. The TypeScript path parses with `AppDeliverySchema`; a payload that fails
//  there fails here too for every field this screen reads.
//

import Foundation

enum DeliveryOpenError: Error {
  case unverified
  case expired
}

enum DeliveryOpen {
  static func open(
    enc: String,
    ct: String,
    route: RouteFields,
    pinnedIdentity: String,
    now: Int
  ) throws -> Notice.Body {
    guard let routeJson = RouteJson.canonical(route) else { throw DeliveryOpenError.unverified }
    let innerText: String
    do {
      innerText = try PhoneKeys.open(
        enc: enc,
        ct: ct,
        purpose: "deliver",
        aad: PhoneKeys.b64url(Data(routeJson.utf8))
      )
    } catch {
      throw DeliveryOpenError.unverified
    }
    guard let innerData = innerText.data(using: .utf8),
      let inner = try? JSONSerialization.jsonObject(with: innerData) as? [String: Any],
      let p = inner["p"] as? String,
      let s = inner["s"] as? String,
      let payload = try? PhoneKeys.unb64url(p)
    else { throw DeliveryOpenError.unverified }

    var message = Data("musterd-app/v1 signed\n\(routeJson)\n".utf8)
    message.append(payload)
    let ok: Bool
    do {
      ok = try PhoneKeys.verifyEd25519(
        publicKey: pinnedIdentity,
        message: PhoneKeys.b64url(message),
        signature: s
      )
    } catch {
      throw DeliveryOpenError.unverified
    }
    if !ok { throw DeliveryOpenError.unverified }

    guard let body = parse(payload, route: route) else { throw DeliveryOpenError.unverified }
    if case .ask(_, _, _, _, _, _) = body {
      // The ask's own expiry is inside the signed payload. A route expiry is the caller's.
      if let expires = askExpiry(payload), expires <= now { throw DeliveryOpenError.expired }
    }
    return body
  }

  /// The ask payload's expires_at, already known to parse, or nil when this is not an ask.
  private static func askExpiry(_ payload: Data) -> Int? {
    guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      object["kind"] as? String == "ask"
    else { return nil }
    return jsonInt(object["expires_at"])
  }

  private static func parse(_ payload: Data, route: RouteFields) -> Notice.Body? {
    guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      jsonInt(object["v"]) == 1,
      let team = nonEmpty(object["team"]),
      let binding = nonEmpty(object["binding"]),
      team == route.team,
      binding == route.binding,
      let kind = object["kind"] as? String
    else { return nil }

    switch kind {
    case "ask":
      guard jsonInt(object["expires_at"]) == route.expiresAt,
        let ask = object["ask"] as? [String: Any],
        let text = ask["body"] as? String,
        let actionClass = ask["action_class"] as? String,
        actionClass == "advisory" || actionClass == "privileged",
        nonEmpty(ask["id"]) == route.ref,
        let from = nonEmpty(ask["from"]),
        ask["from_kind"] as? String == "agent" || ask["from_kind"] as? String == "human",
        ask["tier"] is String,
        stringOrNull(ask["species"]),
        jsonInt(ask["ts"]) != nil,
        let token = nonEmpty(object["token"]),
        let nonce = nonEmpty(object["nonce"])
      else { return nil }
      _ = token
      let hasApproval: Bool
      if object.keys.contains("approval") {
        guard let approval = object["approval"] as? [String: Any],
          approval["approve"] is [String: Any],
          approval["reject"] is [String: Any]
        else { return nil }
        hasApproval = true
      } else {
        hasApproval = false
      }
      if object.keys.contains("lane") {
        guard let lane = object["lane"] as? [String: Any],
          lane["id"] is String,
          lane["title"] is String
        else { return nil }
      }
      let waiting: Int
      if object.keys.contains("waiting") {
        guard let value = jsonInt(object["waiting"]), value >= 0 else { return nil }
        waiting = value
      } else {
        waiting = 0
      }
      return .ask(
        text: text,
        from: from,
        actionClass: actionClass,
        hasApproval: hasApproval,
        waiting: waiting,
        nonce: nonce
      )
    case "held":
      guard let count = jsonInt(object["count"]), count > 0, jsonInt(object["until"]) != nil else {
        return nil
      }
      return .held(count: count)
    case "paired":
      guard let member = object["member"] as? String,
        let deviceKeyId = nonEmpty(object["device_key_id"]), deviceKeyId.count <= 64
      else {
        return nil
      }
      return .paired(member: member, deviceKeyId: deviceKeyId)
    default:
      return nil
    }
  }

  private static func nonEmpty(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }

  private static func stringOrNull(_ value: Any?) -> Bool {
    value is String || value is NSNull
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

//
//  PinBinding.swift
//  MusterdKeys
//
//  The pairing pin's binding (ADR 676 §5, lane 7g). The phone stores the pin when the relay
//  accepts the pair request, and at that moment there is no channel binding: the id is
//  created later, when a standing key approves this phone. The extension therefore accepts
//  a delivery whose pin has no binding, opens it, and — only after the daemon's signature
//  verifies — writes that route's binding back. An existing binding is never overwritten.
//  An attacker who edits the push cannot set it: the open fails without the daemon's key.
//
//  The phone's device key id comes the same way (lane 7h): the daemon mints it when the standing
//  key approves the phone, and names it only in the signed `paired` delivery. A listed-act answer
//  carries it as its proof's `key_id`, so the extension writes it back by the same rule.
//

import Foundation

enum PinBinding {
  /// A missing stored binding matches any route. A stored one matches only itself.
  static func matches(stored: String?, route: String) -> Bool {
    guard let stored else { return true }
    return stored == route
  }

  /// `json` with `binding` set to `routeBinding` when the pin had none.
  /// Nil when the JSON is not a pin, the route binding is empty, or a stored binding disagrees.
  /// A pin that already names `routeBinding` is returned unchanged.
  static func withBinding(json: String, routeBinding: String) -> String? {
    withField(json: json, field: "binding", value: routeBinding)
  }

  /// `json` with `device_key_id` set from a verified `paired` delivery, by the binding's rule.
  static func withDeviceKey(json: String, deviceKeyId: String) -> String? {
    withField(json: json, field: "device_key_id", value: deviceKeyId)
  }

  /// Set `field` once: absent is written, equal is unchanged, a different stored value is nil.
  private static func withField(json: String, field: String, value: String) -> String? {
    guard !value.isEmpty, value.count <= 64,
      let data = json.data(using: .utf8),
      var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    if object[field] != nil {
      guard let existing = object[field] as? String else { return nil }
      return existing == value ? json : nil
    }
    object[field] = value
    guard let encoded = try? JSONSerialization.data(withJSONObject: object),
      let text = String(data: encoded, encoding: .utf8)
    else { return nil }
    return text
  }
}

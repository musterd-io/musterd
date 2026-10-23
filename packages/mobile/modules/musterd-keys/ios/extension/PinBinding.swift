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
    guard !routeBinding.isEmpty, routeBinding.count <= 64,
      let data = json.data(using: .utf8),
      var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    if object["binding"] != nil {
      guard let existing = object["binding"] as? String else { return nil }
      return existing == routeBinding ? json : nil
    }
    object["binding"] = routeBinding
    guard let encoded = try? JSONSerialization.data(withJSONObject: object),
      let text = String(data: encoded, encoding: .utf8)
    else { return nil }
    return text
  }
}

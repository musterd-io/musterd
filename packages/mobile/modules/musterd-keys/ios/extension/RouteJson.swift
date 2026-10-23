//
//  RouteJson.swift
//  MusterdKeys
//
//  Canonical JSON of the four route fields, keys sorted, matching `canonicalJson` in
//  `@musterd/protocol/approval` for this object. The daemon signs that string and uses it as
//  the HPKE AAD (`notify/appSeal.ts`). A string is escaped by JSONSerialization, which matches
//  JSON.stringify for the characters a route can hold. The fixture the tests pin:
//  {"binding":"bind-1","expires_at":4102444800000,"ref":"ask-9f3k","team":"revive"}
//

import Foundation

struct RouteFields {
  var team: String
  var binding: String
  var ref: String
  var expiresAt: Int
}

enum RouteJson {
  /// Nil when a field cannot be encoded. The caller fails closed.
  static func canonical(_ route: RouteFields) -> String? {
    guard let binding = jsonString(route.binding),
      let ref = jsonString(route.ref),
      let team = jsonString(route.team)
    else { return nil }
    return "{\"binding\":\(binding),\"expires_at\":\(route.expiresAt),\"ref\":\(ref),\"team\":\(team)}"
  }

  /// A JSON string literal, quotes included, or nil if the value will not encode.
  static func jsonString(_ value: String) -> String? {
    guard let data = try? JSONSerialization.data(
      withJSONObject: [value],
      options: [.withoutEscapingSlashes]
    ),
      let text = String(data: data, encoding: .utf8),
      text.count >= 2
    else { return nil }
    return String(text.dropFirst().dropLast())
  }
}

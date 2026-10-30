//
//  AskRoutes.swift
//  MusterdKeys
//
//  The pure half of the phone's own list of the asks that reached it (ADR 772). The keychain item
//  that holds the records is `SharedStore`; this type decides what the next record list is. A
//  record is a route and a `seen` flag: no body, no token. Expired records are pruned on every
//  call, and the newest `cap` are kept.
//

import Foundation

enum AskRoutes {
  struct Record: Equatable {
    var team: String
    var binding: String
    var ref: String
    var expiresAt: Int
    var seen: Bool
  }

  static let cap = 50

  /// The extension admitted an ask. A known ref takes the later expiry and keeps its `seen`.
  static func record(records: [Record], adding route: Record, now: Int) -> [Record] {
    var live = prune(records, now: now)
    if route.expiresAt <= now { return live }
    if let i = live.firstIndex(where: { $0.ref == route.ref }) {
      var existing = live.remove(at: i)
      existing.team = route.team
      existing.binding = route.binding
      existing.expiresAt = max(existing.expiresAt, route.expiresAt)
      live.append(existing)
    } else {
      live.append(Record(team: route.team, binding: route.binding, ref: route.ref,
        expiresAt: route.expiresAt, seen: false))
    }
    return Array(live.suffix(cap))
  }

  /// The list showed these asks while the app was active.
  static func markSeen(records: [Record], refs: Set<String>, now: Int) -> [Record] {
    prune(records, now: now).map { record in
      var next = record
      if refs.contains(record.ref) { next.seen = true }
      return next
    }
  }

  /// The daemon called these asks gone.
  static func forget(records: [Record], refs: Set<String>, now: Int) -> [Record] {
    prune(records, now: now).filter { !refs.contains($0.ref) }
  }

  static func prune(_ records: [Record], now: Int) -> [Record] {
    records.filter { $0.expiresAt > now }
  }

  static func encode(_ records: [Record]) -> Data? {
    let array = records.map {
      ["team": $0.team, "binding": $0.binding, "ref": $0.ref, "expiresAt": $0.expiresAt,
        "seen": $0.seen] as [String: Any]
    }
    return try? JSONSerialization.data(withJSONObject: array)
  }

  /// Nil for anything that is not a record list; a bad record fails the whole read.
  static func decode(_ data: Data) -> [Record]? {
    guard let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return nil
    }
    var records: [Record] = []
    for item in array {
      guard let team = item["team"] as? String,
        let binding = item["binding"] as? String,
        let ref = item["ref"] as? String,
        let expires = item["expiresAt"] as? NSNumber,
        CFGetTypeID(expires) != CFBooleanGetTypeID(),
        let seen = item["seen"] as? Bool
      else { return nil }
      records.append(Record(team: team, binding: binding, ref: ref,
        expiresAt: Int(expires.int64Value), seen: seen))
    }
    return records
  }
}

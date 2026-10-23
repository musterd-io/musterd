//
//  SeenNonce.swift
//  MusterdKeys
//
//  The pure half of the seen-nonce rule (ADR 676 decision 8). Spec: `src/native/nonceStore.ts`.
//  The keychain item that holds the records is `SharedStore`; this type decides what the next
//  record list is. Expired does not insert. A replay is not written again. Dead records are
//  pruned on every call.
//

import Foundation

enum SeenNonce {
  struct Record: Equatable {
    var key: String
    var expiresAt: Int
  }

  enum Verdict: String {
    case fresh
    case replay
    case expired
  }

  static func consume(
    records: [Record],
    key: String,
    expiresAt: Int,
    now: Int
  ) -> (records: [Record], verdict: Verdict) {
    let live = records.filter { $0.expiresAt > now }
    if expiresAt <= now { return (live, .expired) }
    if live.contains(where: { $0.key == key }) { return (live, .replay) }
    return (live + [Record(key: key, expiresAt: expiresAt)], .fresh)
  }
}

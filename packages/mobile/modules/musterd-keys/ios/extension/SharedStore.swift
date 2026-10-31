//
//  SharedStore.swift
//  MusterdKeys
//
//  Keychain items the app and the notification extension both read (ADR 676 §8, lane 7f).
//  Same service as the enclave key references (`dev.musterd.keys`) and no kSecAttrAccessGroup:
//  an item with no group lands in the first keychain-access-groups entry, which the config
//  plugin puts first on both targets (`$(AppIdentifierPrefix)io.musterd.app`). SecItem does
//  not expand `$(AppIdentifierPrefix)`, so the attribute is never set to that literal.
//
//  Accessibility is AfterFirstUnlockThisDeviceOnly: a push arrives while the phone may be
//  locked, and the item must not leave the device. The seen-nonce item is one JSON blob.
//  Read-modify-write of that blob is not atomic across the app and the extension; the
//  extension is the writer when a delivery is displayed, and a racing write can drop one
//  record. A lost record shows the delivery again, which the signature check still bounds.
//  A store that cannot be read fails closed — the caller shows the generic notice and does
//  not crash.
//

import Foundation
import Security

enum SharedStore {
  static let service = "dev.musterd.keys"
  static let seenAccount = "seen-nonces"
  static let pushAccount = "push-token"
  static let pinAccount = "pairing-pin"
  static let askRoutesAccount = "ask-routes"
  static let refusalsAccount = "refusals"
  static let questionsAccount = "question-routes"
  static let questionKeyAccount = "question-key-enrolled"
  static let questionOutboxAccount = "question-outbox"

  struct PushToken {
    var token: String
    var environment: String
  }

  /// Nil when the item cannot be read or written. Missing is an empty store, not a failure.
  static func consumeNonce(key: String, expiresAt: Int, now: Int) -> SeenNonce.Verdict? {
    let existing: [SeenNonce.Record]
    switch load(account: seenAccount) {
    case .missing:
      existing = []
    case .failed:
      return nil
    case .data(let data):
      guard let decoded = decodeRecords(data) else { return nil }
      existing = decoded
    }
    let result = SeenNonce.consume(records: existing, key: key, expiresAt: expiresAt, now: now)
    if result.verdict == .fresh {
      guard saveRecords(result.records) else { return nil }
    } else if result.records != existing {
      _ = saveRecords(result.records)
    }
    return result.verdict
  }

  /// The phone's own list of the asks that reached it (ADR 772). Missing or unreadable is empty:
  /// the list still has Notification Center, and the next redelivery restores a lost record.
  static func loadAskRoutes() -> [AskRoutes.Record] {
    guard case .data(let data) = load(account: askRoutesAccount) else { return [] }
    return AskRoutes.decode(data) ?? []
  }

  /// Read, change, write. False when the write fails; the caller carries on either way.
  @discardableResult
  static func updateAskRoutes(_ change: ([AskRoutes.Record]) -> [AskRoutes.Record]) -> Bool {
    let current = loadAskRoutes()
    let next = change(current)
    if next == current { return true }
    guard let data = AskRoutes.encode(next) else { return false }
    return save(data, account: askRoutesAccount)
  }

  /// The questions the extension admitted (ADR 773/774), for the lock-screen answer.
  static func loadQuestions() -> [Question.Pending] {
    guard case .data(let data) = load(account: questionsAccount) else { return [] }
    return Question.decode(data)
  }

  @discardableResult
  static func updateQuestions(_ change: ([Question.Pending]) -> [Question.Pending]) -> Bool {
    let current = loadQuestions()
    let next = change(current)
    if next == current { return true }
    guard let data = Question.encode(next) else { return false }
    return save(data, account: questionsAccount)
  }

  /// The question key this binding enrolled (ADR 774 §5), as the app last sent it: the binding,
  /// the key's public point, and that enrollment's seal expiry (the next must be later).
  static func loadQuestionEnrollment() -> (binding: String, key: String, expiresAt: Int)? {
    guard case .data(let data) = load(account: questionKeyAccount),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let binding = object["binding"] as? String,
      let key = object["key"] as? String,
      let expiresAt = (object["expires_at"] as? NSNumber)?.intValue
    else { return nil }
    return (binding, key, expiresAt)
  }

  @discardableResult
  static func saveQuestionEnrollment(binding: String, key: String, expiresAt: Int) -> Bool {
    let object: [String: Any] = ["binding": binding, "key": key, "expires_at": expiresAt]
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return false }
    return save(data, account: questionKeyAccount)
  }

  /// Whether a question on `binding` can be answered from its notification.
  static func questionKeyEnrolled(binding: String) -> Bool {
    loadQuestionEnrollment()?.binding == binding
  }

  /// Lock-screen answers the relay did not take, each `{url, body, ref, expires_at}`.
  static func loadQuestionOutbox() -> [[String: Any]] {
    guard case .data(let data) = load(account: questionOutboxAccount),
      let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return array
  }

  @discardableResult
  static func saveQuestionOutbox(_ items: [[String: Any]]) -> Bool {
    guard let data = try? JSONSerialization.data(withJSONObject: items) else { return false }
    return save(data, account: questionOutboxAccount)
  }

  /// Why the extension refused a delivery (ADR 777): a coarse reason and the time, the last 10.
  /// Nothing from the delivery is kept. A failed write is dropped: this is diagnostics only.
  static func recordRefusal(_ reason: String, at now: Int) {
    var records: [[String: Any]] = []
    if case .data(let data) = load(account: refusalsAccount),
      let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    {
      records = array
    }
    records.append(["reason": reason, "at": now])
    guard let data = try? JSONSerialization.data(withJSONObject: Array(records.suffix(10)))
    else { return }
    _ = save(data, account: refusalsAccount)
  }

  static func loadRefusals() -> [[String: Any]] {
    guard case .data(let data) = load(account: refusalsAccount),
      let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return array.filter { $0["reason"] is String && $0["at"] is NSNumber }
  }

  static func savePushToken(token: String, environment: String) {
    guard token.range(of: "^[0-9a-f]{64,200}$", options: .regularExpression) != nil,
      environment == "production" || environment == "development",
      let data = try? JSONSerialization.data(withJSONObject: [
        "token": token,
        "environment": environment,
      ])
    else { return }
    _ = save(data, account: pushAccount)
  }

  static func loadPushToken() -> PushToken? {
    guard case .data(let data) = load(account: pushAccount),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let token = object["token"] as? String,
      let environment = object["environment"] as? String,
      token.range(of: "^[0-9a-f]{64,200}$", options: .regularExpression) != nil,
      environment == "production" || environment == "development"
    else { return nil }
    return PushToken(token: token, environment: environment)
  }

  /// `json` was validated by `pairingPin.ts`. This rejects a value that is not even that shape.
  static func savePairingPin(json: String) throws {
    guard let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let version = object["v"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(),
      version.intValue == 1,
      object["identity"] is String,
      object["receive"] is String,
      let relay = object["relay"] as? String,
      relay.hasPrefix("https://"),
      !relay.contains("@"),
      object["team"] is String,
      bindingOk(object["binding"])
    else {
      throw PhoneKeysError.unavailable("pairing pin is malformed")
    }
    guard save(data, account: pinAccount) else {
      throw PhoneKeysError.unavailable("could not store the pairing pin")
    }
  }

  /// Absent until the extension learns it. Present and not a short string is a malformed pin.
  private static func bindingOk(_ value: Any?) -> Bool {
    if value == nil { return true }
    guard let text = value as? String, !text.isEmpty, text.count <= 64 else { return false }
    return true
  }

  static func loadPairingPin() -> String? {
    guard case .data(let data) = load(account: pinAccount) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  // MARK: - Records

  private static func decodeRecords(_ data: Data) -> [SeenNonce.Record]? {
    guard let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return nil
    }
    var records: [SeenNonce.Record] = []
    for item in array {
      guard let key = item["key"] as? String,
        let expires = item["expiresAt"] as? NSNumber,
        CFGetTypeID(expires) != CFBooleanGetTypeID()
      else { return nil }
      records.append(SeenNonce.Record(key: key, expiresAt: Int(expires.int64Value)))
    }
    return records
  }

  private static func saveRecords(_ records: [SeenNonce.Record]) -> Bool {
    let array = records.map { ["key": $0.key, "expiresAt": $0.expiresAt] as [String: Any] }
    guard let data = try? JSONSerialization.data(withJSONObject: array) else { return false }
    return save(data, account: seenAccount)
  }

  // MARK: - Keychain

  private enum Load {
    case missing
    case data(Data)
    case failed
  }

  private static func load(account: String) -> Load {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess, let data = item as? Data else { return .failed }
    return .data(data)
  }

  private static func save(_ data: Data, account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add.merge(attributes) { current, _ in current }
      return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    return status == errSecSuccess
  }
}

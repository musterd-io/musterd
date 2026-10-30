//
//  Readable.swift
//  MusterdKeys
//
//  An ask's text made easier to read on the lock screen. The Swift copy of `plain` and `summary`
//  in `src/native/readable.ts`; `logic-check.swift` runs the same fixtures as its test. Only the
//  marks go: markdown, backticks, a `[lane]` tag, and a full 26-character id shown as its first 10.
//

import Foundation

enum Readable {
  private static let rules: [(String, String, NSRegularExpression.Options)] = [
    (#"^\s*\[[a-z-]+\]\s*"#, "", []),
    ("```", "", []),
    ("`([^`\\n]+)`", "$1", []),
    (#"\*\*([^*\n]+)\*\*"#, "$1", []),
    (#"__([^_\n]+)__"#, "$1", []),
    (#"^\s*#{1,6}\s+"#, "", [.anchorsMatchLines]),
    (#"^\s*(?:[-*•]|\d+[.)])\s+"#, "• ", [.anchorsMatchLines]),
    (#"\b([0-9A-HJKMNP-TV-Z]{10})[0-9A-HJKMNP-TV-Z]{16}\b"#, "$1", []),
    (#"\s+"#, " ", []),
  ]

  static func plain(_ text: String) -> String {
    var out = text
    for (pattern, template, options) in rules {
      guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
      out = regex.stringByReplacingMatches(
        in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
    }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// `plain`, cut to `max` characters: at the last sentence end if there is one, else a word.
  static func summary(_ text: String, max: Int = 160) -> String {
    let line = plain(text)
    if line.count <= max { return line }
    let head = String(line.prefix(max))
    let ends = [". ", "? ", "! "].compactMap { head.range(of: $0, options: .backwards) }
    if let end = ends.max(by: { $0.lowerBound < $1.lowerBound }),
      head.distance(from: head.startIndex, to: end.lowerBound) >= 40
    {
      return String(head[..<end.lowerBound]) + String(head[end.lowerBound])
    }
    let limit = head.index(head.startIndex, offsetBy: max - 1)
    let cut = head[..<limit].range(of: " ", options: .backwards)?.lowerBound ?? limit
    var kept = String(head[..<cut])
    while let last = kept.last, " ,;:·—-".contains(last) { kept.removeLast() }
    return kept + "…"
  }
}

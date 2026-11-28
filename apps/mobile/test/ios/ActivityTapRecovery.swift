import Foundation

// Each phase runs in a separate process. No scene or React observer exists when the intent runs.
@main
struct ActivityTapRecovery {
  static func main() async throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[2])
    let inbox = LeveActivityInbox(root: root)
    switch CommandLine.arguments[1] {
    case "tap":
      for target in ["unchanged:log", "edited:log"] {
        let applied = await inbox.deliver(source: "system-activity", target: target) { _ in }
        precondition(!applied) // Opens the foreground scene. The files must still be there.
      }
    case "recover":
      let taps = try await inbox.pending()
      precondition(Set(taps.map(\.target)) == ["unchanged:log", "edited:log"])
      for tap in taps {
        precondition(!tap.reviewOnly && tap.source == "system-activity")
        try await inbox.finish(id: tap.id.uuidString, applied: tap.target == "unchanged:log", reviewed: false)
      }
    case "review":
      let taps = try await inbox.pending()
      precondition(taps.count == 1 && taps[0].reviewOnly && taps[0].target == "edited:log")
      try await inbox.finish(id: taps[0].id.uuidString, applied: false, reviewed: true)
    case "verify":
      verifyRestActions()
      let cold = LeveActivityInbox(root: root)
      let loading = await cold.needsConsumer()
      precondition(loading)
      let wake = try await cold.enqueue(source: "activity", target: "cold:log")
      let receipt = Task { try await cold.result(for: wake.id, waitForStartup: true) }
      try await Task.sleep(nanoseconds: 150_000_000)
      let queued = try await cold.pending()
      precondition(queued.contains { $0.id == wake.id && !$0.reviewOnly })
      try await cold.finish(id: wake.id.uuidString, applied: true, reviewed: false)
      let accepted = try await receipt.value
      precondition(accepted)
      let pending = try await inbox.pending()
      precondition(pending.isEmpty)
      for applied in [true, false] {
        let tap = try await inbox.enqueue(source: "system-activity", target: "opaque-ticket:log")
        try await inbox.finish(id: tap.id.uuidString, applied: applied, reviewed: !applied)
        let result = try await inbox.result(for: tap.id)
        precondition(result == applied)
      }
      // A prior v1 ticket, a malformed payload, and a new tap can share one inbox.
      let directory = root.appendingPathComponent("LeveActivityTaps-v1")
      let oldID = UUID(), badID = UUID()
      let old: [String: Any] = ["id": oldID.uuidString, "source": "activity",
                                "target": "previous:log", "timestamp": 1]
      try JSONSerialization.data(withJSONObject: old).write(to: directory.appendingPathComponent(oldID.uuidString))
      try Data("{".utf8).write(to: directory.appendingPathComponent(badID.uuidString))
      let newTap = try await inbox.enqueue(source: "activity", target: "new:log")
      let mixed = try await inbox.pending()
      precondition(mixed.count == 3)
      precondition(mixed.contains { $0.id == oldID && $0.target == "previous:log" && !$0.reviewOnly })
      precondition(mixed.contains { $0.id == newTap.id && $0.target == "new:log" && !$0.reviewOnly })
      precondition(mixed.contains { $0.id == badID && $0.reviewOnly && $0.target.isEmpty })
      for tap in mixed {
        try await inbox.finish(id: tap.id.uuidString, applied: !tap.reviewOnly, reviewed: tap.reviewOnly)
      }
      let remaining = try await inbox.pending()
      precondition(remaining.isEmpty)
      let blocked = root.appendingPathComponent("regular-file")
      try Data().write(to: blocked)
      let unreadable = LeveActivityInbox(root: blocked)
      UserDefaults.standard.removeObject(forKey: "LeveReviewWorkout")
      let applied = await unreadable.deliver(source: "activity", target: "ticket:log") { _ in
        preconditionFailure("A failed write cannot deliver a tap")
      }
      precondition(!applied && UserDefaults.standard.bool(forKey: "LeveReviewWorkout"))
    default:
      preconditionFailure("Unexpected test phase")
    }
  }

  static func verifyRestActions() {
    let less = "leveRest.rest-1:less"
    let more = "leveRest.rest-1:more"
    let skip = "leveRest.rest-1:skip"
    var props: [String: Any] = [
      "token": "leve1.previous-ticket", "restKey": "rest-1",
      "restStart": 90_000.0, "restEnd": 150_000.0, "title": "Push A"
    ]
    let shortened = LeveRestAction(target: less)?.change(target: less, props: props, now: 100_000)
    precondition(shortened == LeveRestChange(key: "rest-1", start: 75_000, end: 135_000))
    precondition(shortened?.staleDate?.timeIntervalSince1970 == 135)
    shortened?.apply(to: &props)
    precondition(props["title"] as? String == "Push A")
    precondition(LeveRestAction.less.change(target: less, props: props, now: 101_000)?.end == 120_000)
    precondition(LeveRestAction.more.change(target: more, props: props, now: 101_000)?.end == 150_000)
    precondition(LeveRestAction.less.change(target: less, props: props, now: 125_000)?.end == 0)
    precondition(LeveRestAction.more.change(target: more, props: props, now: 135_000) == nil)
    precondition(LeveRestAction.skip.change(target: "leveRest.old:skip", props: props, now: 101_000) == nil)
    precondition(LeveRestAction(target: "leve1.previous-ticket:skip") == .skip)
    precondition(LeveRestAction(target: "leve1.previous-ticket:log") == nil)
    let skipped = LeveRestAction.skip.change(target: skip, props: props, now: 101_000)
    precondition(skipped == LeveRestChange(key: "rest-1", start: 0, end: 0))
    precondition(skipped?.staleDate == nil)
    skipped?.apply(to: &props)
    precondition(LeveRestAction.more.change(target: more, props: props, now: 102_000) == nil)
  }

}

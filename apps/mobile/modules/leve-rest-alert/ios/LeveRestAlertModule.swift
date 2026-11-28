import ExpoModulesCore
import UserNotifications

// The end-of-rest alert. Local notifications only: Leve registers for no remote notifications and
// needs no push entitlement. iOS forwards a delivered alert to a paired Apple Watch while the
// iPhone is locked.
public final class LeveRestAlertModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LeveRestAlert")

    AsyncFunction("permission") { () async -> String in
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        return "granted"
      case .denied:
        return "denied"
      default:
        return "undetermined"
      }
    }

    AsyncFunction("requestPermission") { () async throws -> Bool in
      try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    // Replaces any alert with this identifier, so there is never more than one.
    AsyncFunction("schedule") { (id: String, title: String, body: String, at: Double) async throws in
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: [id])
      center.removeDeliveredNotifications(withIdentifiers: [id])
      let seconds = at / 1000 - Date().timeIntervalSince1970
      guard seconds > 0 else { return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
      try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    Function("cancel") { (id: String) in
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: [id])
      center.removeDeliveredNotifications(withIdentifiers: [id])
    }
  }
}

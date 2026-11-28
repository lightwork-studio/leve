import Expo
import ExpoModulesCore
import Foundation
import UIKit

private final class BackgroundLogRequest: @unchecked Sendable {
  static let shared = BackgroundLogRequest()
  private let lock = NSLock()
  private var requested = false

  func markRequested() {
    lock.lock()
    defer { lock.unlock() }
    requested = true
  }

  func wasRequested() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return requested
  }
}

public final class LeveActivityBackgroundModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LeveActivityBackground")
    Function("wasRequested") { BackgroundLogRequest.shared.wasRequested() }
  }
}

public final class LeveActivityBackgroundSubscriber: ExpoAppDelegateSubscriber {
  @MainActor private var backgroundWindow: UIWindow?

  public func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenter.default.addObserver(
      self, selector: #selector(startForLog(_:)), name: Notification.Name("LeveActivityLogNeedsRuntime"), object: nil
    )
    return true
  }

  @MainActor
  public func applicationDidBecomeActive(_ application: UIApplication) {
    if let provider = application.delegate as? ExpoReactNativeFactoryProvider,
       provider.window !== backgroundWindow {
      backgroundWindow = nil
    }
  }

  @MainActor
  @objc private func startForLog(_ notification: Notification) {
    guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          provider.window == nil,
          let factory = provider.reactNativeFactory else { return }
    // The Expo Updates delegate chooses the bundle through the normal root-view factory. Give
    // its deferred root a child controller so it can replace that view without showing a window.
    let window = UIWindow()
    let container = UIViewController()
    let host = UIViewController()
    container.addChild(host)
    window.rootViewController = container
    backgroundWindow = window
    provider.window = window

    BackgroundLogRequest.shared.markRequested()
    host.view = factory.rootViewFactory.view(
      withModuleName: "LeveActivityBackground",
      initialProperties: nil,
      launchOptions: nil,
      bundleConfiguration: factory.bundleConfiguration,
      devMenuConfiguration: factory.devMenuConfiguration ?? .default()
    )
    container.view.addSubview(host.view)
    host.didMove(toParent: container)
  }
}

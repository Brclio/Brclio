import AppKit
import ApplicationServices
import Foundation

// Observe from another process so this check cannot mark the downloader's
// launch as finished. Dock accessibility is optional on hosted runners.
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: CommandLine.arguments[1])
if CommandLine.arguments.count == 4, CommandLine.arguments[2] == "--quit" {
    guard let app = apps.first(where: { $0.processIdentifier == Int32(CommandLine.arguments[3]) }),
          app.terminate() else { exit(1) }
    exit(0)
}
func dockItems(_ name: String) -> Int? {
    guard AXIsProcessTrusted(), let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
    var matches = 0
    func scan(_ item: AXUIElement, _ depth: Int) {
        guard depth < 4 else { return }
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(item, kAXTitleAttribute as CFString, &value) == .success, value as? String == name { matches += 1 }
        if AXUIElementCopyAttributeValue(item, kAXChildrenAttribute as CFString, &value) == .success, let children = value as? [AXUIElement] {
            for child in children { scan(child, depth + 1) }
        }
    }
    scan(AXUIElementCreateApplication(dock.processIdentifier), 0)
    return matches
}
let state = apps.map { app -> [String: Any] in
    var record: [String: Any] = ["pid": Int(app.processIdentifier), "bundle": app.bundleURL?.path ?? "",
                                  "regular": app.activationPolicy == .regular, "finished": app.isFinishedLaunching]
    if let name = app.localizedName, let count = dockItems(name) { record["dockItems"] = count }
    return record
}
let bytes = try JSONSerialization.data(withJSONObject: state)
print(String(decoding: bytes, as: UTF8.self))

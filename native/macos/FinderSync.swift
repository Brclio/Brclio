import AppKit
import FinderSync
import Foundation
import OSLog

/// Finder only supplies selected URLs. Formatting and clipboard access remain
/// in the containing application, using its persisted cross-platform settings.
final class FinderSync: FIFinderSync {
    private static let logger = Logger(subsystem: "com.brclio.toolbox.finder-sync", category: "copy")
    private static let maximumPathCount = 1_000
    private static let maximumPayloadBytes = 128 * 1_024
    private var selections: [Int: [String]] = [:]
    private var nextSelection = 0

    override init() {
        super.init()
        // Register Finder UI coverage. This extension never enumerates folders,
        // reads file contents, creates badges, or handles observation callbacks.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/", isDirectory: true)]
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let controller = FIFinderSyncController.default()
        guard let paths = Self.selectedPaths(for: menuKind, selected: controller.selectedItemURLs() ?? [], target: controller.targetedURL()) else { return nil }
        let menu = NSMenu(title: "Brclio")
        let item = NSMenuItem(title: "复制路径 · Brclio", action: #selector(copyPath(_:)), keyEquivalent: "")
        item.target = self
        // Finder forwards the tag through its remote menu, but discards an
        // arbitrary representedObject. Retain the exact menu selection here.
        nextSelection = nextSelection == Int.max ? 1 : nextSelection + 1
        item.tag = nextSelection
        selections[nextSelection] = paths
        if selections.count > 32, let oldest = selections.keys.min() {
            selections.removeValue(forKey: oldest)
        }
        menu.addItem(item)
        return menu
    }

    static func selectedPaths(for menuKind: FIMenuKind, selected: [URL], target: URL?) -> [String]? {
        let urls: [URL]
        switch menuKind {
        case .contextualMenuForContainer, .contextualMenuForSidebar:
            // A background click copies the displayed folder, even when Finder
            // still has selected items from an earlier click.
            urls = target.map { [$0] } ?? []
        case .contextualMenuForItems:
            urls = selected.isEmpty ? target.map { [$0] } ?? [] : selected
        default:
            return nil
        }

        return paths(from: urls)
    }

    @objc private func copyPath(_ sender: NSMenuItem) {
        guard let paths = selections.removeValue(forKey: sender.tag),
              let commandURL = Self.commandURL(for: paths) else {
            Self.logger.error("Invalid Finder selection")
            return
        }
        guard let applicationURL = Self.containingApplicationURL() else {
            Self.logger.error("Containing application unavailable")
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        // Reuse a capable running copy of Brclio even after an app move/update,
        // so a second disk copy cannot lose the URL at Electron's instance lock.
        configuration.allowsRunningApplicationSubstitution = true
        configuration.createsNewApplicationInstance = false
        configuration.promptsUserIfNeeded = false
        // Sandbox callers cannot pass launch arguments. A targeted URL event
        // works with a running or closed container without a shared file store.
        NSWorkspace.shared.open([commandURL], withApplicationAt: applicationURL, configuration: configuration) { _, error in
            if let error = error {
                let failure = error as NSError
                Self.logger.error("Containing application launch failed: \(failure.domain, privacy: .public) (\(failure.code))")
            }
        }
    }

    private static func paths(from urls: [URL]) -> [String]? {
        guard !urls.isEmpty, urls.count <= maximumPathCount,
              urls.allSatisfy({ $0.isFileURL }) else { return nil }
        let paths = urls.map(\.path)
        return commandURL(for: paths) == nil ? nil : paths
    }

    static func commandURL(for paths: [String]) -> URL? {
        guard !paths.isEmpty, paths.count <= maximumPathCount,
              paths.allSatisfy({ $0.hasPrefix("/") && !$0.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) }),
              let json = try? JSONSerialization.data(withJSONObject: paths, options: [.withoutEscapingSlashes]),
              json.count <= maximumPayloadBytes else { return nil }
        let payload = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        var components = URLComponents()
        components.scheme = "brclio"
        components.host = "copy-path"
        components.queryItems = [URLQueryItem(name: "payload", value: payload)]
        return components.url
    }

    private static func containingApplicationURL() -> URL? {
        let extensionURL = Bundle.main.bundleURL
        guard extensionURL.pathExtension == "appex" else { return nil }
        let applicationURL = extensionURL.deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard applicationURL.pathExtension == "app",
              Bundle(url: applicationURL)?.bundleIdentifier == "com.brclio.toolbox" else { return nil }
        return applicationURL
    }
}

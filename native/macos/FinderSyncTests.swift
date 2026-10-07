import FinderSync
import Foundation

@main
enum FinderSyncTests {
    static func main() throws {
        let paths = ["/Users/test/中文 空格/one.txt", "/Volumes/Test/O'Reilly \"file\";$(touch x)&.txt", "/Applications/Brclio.app"]
        let url = try require(FinderSync.commandURL(for: paths), "valid selection")
        let components = try require(URLComponents(url: url, resolvingAgainstBaseURL: false), "URL components")
        precondition(components.scheme == "brclio" && components.host == "copy-path")
        precondition(components.queryItems?.count == 1 && components.queryItems?.first?.name == "payload")
        let payload = try require(components.queryItems?.first?.value, "payload")
        precondition(payload.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil)
        var base64 = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        let decoded = try require(Data(base64Encoded: base64), "base64url decoding")
        let roundtrip = try JSONSerialization.jsonObject(with: decoded) as? [String]
        precondition(roundtrip == paths)
        precondition(FinderSync.commandURL(for: ["/家庭👨‍👩‍👧.txt"]) != nil)
        precondition(FinderSync.commandURL(for: []) == nil)
        precondition(FinderSync.commandURL(for: ["relative/path"]) == nil)
        precondition(FinderSync.commandURL(for: ["/line\nbreak"]) == nil)
        precondition(FinderSync.commandURL(for: ["/nul\u{0000}"]) == nil)
        precondition(FinderSync.commandURL(for: ["/del\u{007F}"]) == nil)
        precondition(FinderSync.commandURL(for: ["/c1\u{0085}"]) == nil)
        precondition(FinderSync.commandURL(for: Array(repeating: "/x", count: 1_000)) != nil)
        precondition(FinderSync.commandURL(for: Array(repeating: "/x", count: 1_001)) == nil)
        precondition(FinderSync.commandURL(for: ["/" + String(repeating: "x", count: 128 * 1_024)]) == nil)

        let selected = paths.prefix(2).map { URL(fileURLWithPath: $0) }
        let target = URL(fileURLWithPath: "/Users/test/folder", isDirectory: true)
        precondition(FinderSync.selectedPaths(for: .contextualMenuForContainer, selected: selected, target: target) == [target.path])
        precondition(FinderSync.selectedPaths(for: .contextualMenuForSidebar, selected: selected, target: target) == [target.path])
        precondition(FinderSync.selectedPaths(for: .contextualMenuForItems, selected: selected, target: target) == Array(paths.prefix(2)))
        precondition(FinderSync.selectedPaths(for: .contextualMenuForItems, selected: [], target: target) == [target.path])
        precondition(FinderSync.selectedPaths(for: .contextualMenuForItems, selected: [], target: nil) == nil)
        precondition(FinderSync.selectedPaths(for: .toolbarItemMenu, selected: selected, target: target) == nil)
        precondition(FinderSync.selectedPaths(for: .contextualMenuForItems, selected: [URL(string: "https://example.com/file")!], target: target) == nil)
        print("PASS: native Finder selection semantics, exact Unicode/shell-text URL roundtrip, limits and invalid input")
    }

    private static func require<T>(_ value: T?, _ label: String) throws -> T {
        guard let value = value else { throw NSError(domain: "BrclioFinderSyncTests", code: 1, userInfo: [NSLocalizedDescriptionKey: label]) }
        return value
    }
}

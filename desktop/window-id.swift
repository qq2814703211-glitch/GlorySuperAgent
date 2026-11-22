import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
if let window = windows.first(where: {
    $0[kCGWindowOwnerName as String] as? String == CommandLine.arguments[1] &&
    $0[kCGWindowLayer as String] as? Int == 0 &&
    ($0[kCGWindowName as String] as? String)?.contains("Superagent") == true
}), let number = window[kCGWindowNumber as String] as? Int {
    print(number)
}

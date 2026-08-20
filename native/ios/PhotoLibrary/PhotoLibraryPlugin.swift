import Capacitor
import CoreLocation
import Foundation
import Photos

/// Native PhotoKit bridge for the Lost & Found wizard.
///
/// It reads only each photo's geotag (`PHAsset.location`) and capture time
/// (`PHAsset.creationDate`) — both are asset *metadata*, so no image pixels are
/// ever decoded or loaded. That makes scanning a whole day of 100+ photos
/// near-instant, and nothing leaves the device: only `{lat, lng, time}` triples
/// are handed back to the WebView.
///
/// Registered as "PhotoLibrary" (see PhotoLibraryPlugin.m), matching
/// `registerPlugin("PhotoLibrary", …)` in shell/native/photo-library.ts.
@objc(PhotoLibraryPlugin)
public class PhotoLibraryPlugin: CAPPlugin {

    /// Prompt for photo-library access; resolves `{ status }`.
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        let complete: (PHAuthorizationStatus) -> Void = { status in
            call.resolve(["status": PhotoLibraryPlugin.statusString(status)])
        }
        if #available(iOS 14, *) {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { complete($0) }
        } else {
            PHPhotoLibrary.requestAuthorization { complete($0) }
        }
    }

    /// Fetch `{lat, lng, time}` for located photos, optionally limited to one
    /// day, an inclusive date range, or the last N days. Resolves
    /// `{ status, total, withGps, points }`.
    @objc func fetchPhotoPoints(_ call: CAPPluginCall) {
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }
        guard status == .authorized || status == .limited else {
            call.resolve([
                "status": PhotoLibraryPlugin.statusString(status),
                "total": 0,
                "withGps": 0,
                "points": [],
            ])
            return
        }

        let options = PHFetchOptions()
        options.includeHiddenAssets = false
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]

        var predicates: [NSPredicate] = []
        if let startDate = call.getString("startDate"),
            let endDate = call.getString("endDate"),
            let range = PhotoLibraryPlugin.inclusiveRange(startDate, endDate)
        {
            predicates.append(
                NSPredicate(
                    format: "creationDate >= %@ AND creationDate < %@",
                    range.start as NSDate,
                    range.end as NSDate
                )
            )
        } else if let day = call.getString("day"), let range = PhotoLibraryPlugin.dayRange(day) {
            predicates.append(
                NSPredicate(
                    format: "creationDate >= %@ AND creationDate < %@",
                    range.start as NSDate,
                    range.end as NSDate
                )
            )
        } else if let sinceDays = call.getInt("sinceDays"), sinceDays > 0,
            let start = Calendar.current.date(byAdding: .day, value: -sinceDays, to: Date())
        {
            predicates.append(NSPredicate(format: "creationDate >= %@", start as NSDate))
        }
        if !predicates.isEmpty {
            options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        }
        if let limit = call.getInt("limit"), limit > 0 {
            options.fetchLimit = limit
        }

        // `.image` restricts to photos; live photos and screenshots are images too,
        // but screenshots simply carry no location and fall out of `points`.
        let assets = PHAsset.fetchAssets(with: .image, options: options)

        var points: [[String: Any]] = []
        points.reserveCapacity(assets.count)
        var withGps = 0
        assets.enumerateObjects { asset, _, _ in
            guard let location = asset.location else { return }
            withGps += 1
            let time: Any =
                asset.creationDate.map { $0.timeIntervalSince1970 * 1000.0 } ?? NSNull()
            points.append([
                "lat": location.coordinate.latitude,
                "lng": location.coordinate.longitude,
                "time": time,
            ])
        }

        call.resolve([
            "status": PhotoLibraryPlugin.statusString(status),
            "total": assets.count,
            "withGps": withGps,
            "points": points,
        ])
    }

    private static func statusString(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    /// Half-open [start, next-day) range for a device-local "yyyy-MM-dd" day.
    private static func dayRange(_ day: String) -> (start: Date, end: Date)? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        guard let start = formatter.date(from: day),
            let end = Calendar.current.date(byAdding: .day, value: 1, to: start)
        else { return nil }
        return (start, end)
    }

    /// Inclusive local-day range expressed as a half-open Date interval.
    private static func inclusiveRange(_ startDay: String, _ endDay: String) -> (start: Date, end: Date)? {
        guard let start = dayRange(startDay)?.start,
            let inclusiveEnd = dayRange(endDay)?.start,
            inclusiveEnd >= start,
            let end = Calendar.current.date(byAdding: .day, value: 1, to: inclusiveEnd)
        else { return nil }
        return (start, end)
    }
}

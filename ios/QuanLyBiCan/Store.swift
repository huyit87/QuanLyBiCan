import Foundation
import SwiftUI
import UserNotifications
import LocalAuthentication

/// Kho dữ liệu: lưu JSON trong Application Support, bật bảo vệ tệp mức cao nhất của iOS
/// (tệp được mã hoá và không đọc được khi máy đang khoá).
@MainActor
final class Store: ObservableObject {
    @Published private(set) var records: [BiCan] = []
    @Published private(set) var loadError: String?
    @Published var settings: AppSettings {
        didSet { saveSettings(); scheduleNotifications() }
    }

    private let dir: URL
    private var recordsURL: URL { dir.appendingPathComponent("records.json") }
    private var settingsURL: URL { dir.appendingPathComponent("settings.json") }

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let folder = base.appendingPathComponent("QuanLyBiCan", isDirectory: true)
        dir = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let d = try? Data(contentsOf: folder.appendingPathComponent("settings.json")),
           let s = try? JSONDecoder().decode(AppSettings.self, from: d) {
            settings = s
        } else {
            settings = AppSettings()
        }
        load()
    }

    func load() {
        guard FileManager.default.fileExists(atPath: recordsURL.path) else { loadError = nil; return }
        do {
            let d = try Data(contentsOf: recordsURL)
            records = try JSONDecoder().decode([BiCan].self, from: d)
            loadError = nil
        } catch {
            // Không ghi đè khi đọc lỗi, tránh mất dữ liệu.
            loadError = "Không đọc được dữ liệu: \(error.localizedDescription)"
        }
    }

    private func save() {
        guard loadError == nil else { return }
        do {
            let d = try JSONEncoder().encode(records)
            try d.write(to: recordsURL, options: [.atomic, .completeFileProtection])
        } catch {
            loadError = "Không lưu được dữ liệu: \(error.localizedDescription)"
        }
        scheduleNotifications()
    }

    private func saveSettings() {
        if let d = try? JSONEncoder().encode(settings) {
            try? d.write(to: settingsURL, options: [.atomic, .completeFileProtection])
        }
    }

    func record(_ id: String) -> BiCan? { records.first { $0.id == id } }

    func upsert(_ r: BiCan) {
        var r = r
        r.giaHan.removeAll { $0.trong }
        r.updatedAt = Date().timeIntervalSince1970 * 1000
        if let i = records.firstIndex(where: { $0.id == r.id }) { records[i] = r } else { records.append(r) }
        save()
    }

    func delete(_ id: String) {
        records.removeAll { $0.id == id }
        save()
    }

    func deleteAll() {
        records = []
        loadError = nil
        try? FileManager.default.removeItem(at: recordsURL)
        scheduleNotifications()
    }

    /// Gộp hồ sơ từ bản sao lưu: hồ sơ mới thì thêm, hồ sơ trùng thì giữ bản cập nhật sau.
    func merge(_ incoming: [BiCan]) -> (them: Int, capNhat: Int) {
        var them = 0, capNhat = 0
        for r in incoming {
            if let i = records.firstIndex(where: { $0.id == r.id }) {
                if records[i].updatedAt < r.updatedAt { records[i] = r; capNhat += 1 }
            } else {
                records.append(r); them += 1
            }
        }
        save()
        return (them, capNhat)
    }

    var canChuY: [BiCan] {
        records.filter { ($0.hanInfo(canhBao: settings.alertDays)?.muc ?? .binhThuong) != .binhThuong }
            .sorted { ($0.hanHienTai ?? "") < ($1.hanHienTai ?? "") }
    }

    // MARK: Thông báo nhắc hạn

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                if granted { self.scheduleNotifications() } else { self.settings.notifEnabled = false }
            }
        }
    }

    func scheduleNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        guard settings.notifEnabled else { return }

        let now = Date()
        var items: [(date: Date, body: String)] = []
        for r in records {
            guard let han = r.hanHienTai, let day = Ngay.parse(han) else { continue }
            let ten = settings.notifShowName ? r.hoTen : "một bị can"
            let loai = r.bp.ten.lowercased()
            if let fire = Ngay.lich.date(bySettingHour: 8, minute: 0, second: 0, of: day), fire > now {
                items.append((fire, "Hôm nay hết hạn \(loai) của \(ten) (\(Ngay.vn(han)))."))
            }
            if let early = Ngay.lich.date(byAdding: .day, value: -settings.alertDays, to: day),
               let fire = Ngay.lich.date(bySettingHour: 8, minute: 0, second: 0, of: early), fire > now {
                items.append((fire, "Còn \(settings.alertDays) ngày nữa hết hạn \(loai) của \(ten) (\(Ngay.vn(han)))."))
            }
        }
        // iOS chỉ giữ tối đa 64 thông báo chờ: ưu tiên các hạn gần nhất.
        for (i, it) in items.sorted(by: { $0.date < $1.date }).prefix(60).enumerated() {
            let content = UNMutableNotificationContent()
            content.title = "Hạn tạm giữ, tạm giam"
            content.body = it.body
            content.sound = .default
            let comps = Ngay.lich.dateComponents([.year, .month, .day, .hour, .minute], from: it.date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            center.add(UNNotificationRequest(identifier: "han-\(i)", content: content, trigger: trigger))
        }
    }
}

/// Khoá ứng dụng bằng Face ID / Touch ID / mật mã máy.
@MainActor
final class AppLock: ObservableObject {
    @Published var unlocked = false
    @Published var message = ""
    private var backgroundAt: Date?
    private let autoLockSeconds: TimeInterval = 60

    func authenticate() {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            // Máy chưa đặt mật mã: không có gì để xác thực.
            unlocked = true
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Mở khoá hồ sơ bị can") { ok, _ in
            Task { @MainActor in
                self.unlocked = ok
                self.message = ok ? "" : "Chưa xác thực được."
            }
        }
    }

    func phaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if backgroundAt == nil { backgroundAt = Date() }
        case .active:
            guard let t = backgroundAt else { return }
            backgroundAt = nil
            // LockView tự gọi xác thực khi hiện ra.
            if Date().timeIntervalSince(t) > autoLockSeconds { unlocked = false }
        default:
            break
        }
    }

    func lockNow() { unlocked = false; message = "" }
}

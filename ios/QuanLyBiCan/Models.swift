import Foundation

// MARK: - Danh mục

enum BienPhap: String, CaseIterable, Identifiable {
    case tamgiam, tamgiu, camdi, baolinh, dattien, truyna, khac
    var id: String { rawValue }
    var ten: String {
        switch self {
        case .tamgiam: return "Tạm giam"
        case .tamgiu: return "Tạm giữ"
        case .camdi: return "Cấm đi khỏi nơi cư trú"
        case .baolinh: return "Bảo lĩnh"
        case .dattien: return "Đặt tiền để bảo đảm"
        case .truyna: return "Đang truy nã"
        case .khac: return "Khác / chưa áp dụng"
        }
    }
    var laGiamGiu: Bool { self == .tamgiam || self == .tamgiu }
    var laTaiNgoai: Bool { self == .camdi || self == .baolinh || self == .dattien }
}

enum GiaiDoan: String, CaseIterable, Identifiable {
    case dieutra, ketluan, truyto, xetxu, tamdinhchi, dinhchi
    var id: String { rawValue }
    var ten: String {
        switch self {
        case .dieutra: return "Đang điều tra"
        case .ketluan: return "Đã kết luận điều tra"
        case .truyto: return "Truy tố"
        case .xetxu: return "Xét xử"
        case .tamdinhchi: return "Tạm đình chỉ"
        case .dinhchi: return "Đình chỉ"
        }
    }
}

// MARK: - Ngày tháng (lưu dạng chuỗi yyyy-MM-dd, rỗng nếu chưa có)

enum Ngay {
    static let lich: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        return c
    }()
    private static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.calendar = lich
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func parse(_ s: String) -> Date? { s.isEmpty ? nil : fmt.date(from: s) }
    static func iso(_ d: Date) -> String { fmt.string(from: d) }
    static var homNay: String { iso(Date()) }

    /// yyyy-MM-dd -> dd/MM/yyyy
    static func vn(_ s: String) -> String {
        let p = s.split(separator: "-")
        return p.count == 3 ? "\(p[2])/\(p[1])/\(p[0])" : s
    }
    static func congNgay(_ s: String, _ n: Int) -> String {
        guard let d = parse(s), let r = lich.date(byAdding: .day, value: n, to: d) else { return "" }
        return iso(r)
    }
    static func soNgay(tu a: String, den b: String) -> Int? {
        guard let da = parse(a), let db = parse(b) else { return nil }
        return lich.dateComponents([.day], from: lich.startOfDay(for: da), to: lich.startOfDay(for: db)).day
    }
    /// Đến ngày = từ ngày + số ngày − 1 (tính cả ngày bắt đầu), tương đương =B4+VLOOKUP(A4;bảng;2;0)-1
    static func denNgay(tu: String, soNgay: Int) -> String {
        guard soNgay > 0, !tu.isEmpty else { return "" }
        return congNgay(tu, soNgay - 1)
    }
}

extension KeyedDecodingContainer {
    func chuoi(_ k: Key) -> String { (try? decodeIfPresent(String.self, forKey: k)) ?? "" }
    func so(_ k: Key) -> Double { (try? decodeIfPresent(Double.self, forKey: k)) ?? 0 }
}

// MARK: - Hồ sơ (tên trường trùng với bản web để dùng chung tệp sao lưu)

struct GiaHan: Identifiable, Hashable, Codable {
    var id = UUID()
    var so = ""
    var loai = ""
    var tu = ""
    var den = ""

    enum CodingKeys: String, CodingKey { case so, loai, tu, den }

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        so = c.chuoi(.so); loai = c.chuoi(.loai); tu = c.chuoi(.tu); den = c.chuoi(.den)
    }
    var trong: Bool { so.isEmpty && tu.isEmpty && den.isEmpty }
}

struct BiCan: Identifiable, Hashable, Codable {
    var id = UUID().uuidString.lowercased()
    var hoTen = ""
    var tenKhac = ""
    var gioiTinh = "Nam"
    var ngaySinh = ""
    var cccd = ""
    var quocTich = "Việt Nam"
    var danToc = "Kinh"
    var ngheNghiep = ""
    var hktt = ""
    var choO = ""
    var tienAn = ""
    var anh = ""            // data URL JPEG (data:image/jpeg;base64,...)
    var vuAn = ""
    var soQDKTVA = ""
    var ngayKTVA = ""
    var toiDanh = ""
    var dieuKhoan = ""
    var soQDKTBC = ""
    var ngayKTBC = ""
    var giaiDoan = GiaiDoan.dieutra.rawValue
    var bienPhap = BienPhap.tamgiam.rawValue
    var ngayBat = ""
    var noiGiam = ""
    var soLenh = ""
    var loaiHan = ""
    var tgTu = ""
    var tgDen = ""
    var giaHan: [GiaHan] = []
    var dtv = ""
    var ksv = ""
    var ghiChu = ""
    var createdAt = Date().timeIntervalSince1970 * 1000
    var updatedAt = Date().timeIntervalSince1970 * 1000

    enum CodingKeys: String, CodingKey {
        case id, hoTen, tenKhac, gioiTinh, ngaySinh, cccd, quocTich, danToc, ngheNghiep, hktt, choO, tienAn, anh
        case vuAn, soQDKTVA, ngayKTVA, toiDanh, dieuKhoan, soQDKTBC, ngayKTBC, giaiDoan
        case bienPhap, ngayBat, noiGiam, soLenh, loaiHan, tgTu, tgDen, giaHan, dtv, ksv, ghiChu, createdAt, updatedAt
    }

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        hoTen = c.chuoi(.hoTen); tenKhac = c.chuoi(.tenKhac); gioiTinh = c.chuoi(.gioiTinh); ngaySinh = c.chuoi(.ngaySinh)
        cccd = c.chuoi(.cccd); quocTich = c.chuoi(.quocTich); danToc = c.chuoi(.danToc); ngheNghiep = c.chuoi(.ngheNghiep)
        hktt = c.chuoi(.hktt); choO = c.chuoi(.choO); tienAn = c.chuoi(.tienAn); anh = c.chuoi(.anh)
        vuAn = c.chuoi(.vuAn); soQDKTVA = c.chuoi(.soQDKTVA); ngayKTVA = c.chuoi(.ngayKTVA); toiDanh = c.chuoi(.toiDanh)
        dieuKhoan = c.chuoi(.dieuKhoan); soQDKTBC = c.chuoi(.soQDKTBC); ngayKTBC = c.chuoi(.ngayKTBC)
        giaiDoan = c.chuoi(.giaiDoan); bienPhap = c.chuoi(.bienPhap); ngayBat = c.chuoi(.ngayBat); noiGiam = c.chuoi(.noiGiam)
        soLenh = c.chuoi(.soLenh); loaiHan = c.chuoi(.loaiHan); tgTu = c.chuoi(.tgTu); tgDen = c.chuoi(.tgDen)
        giaHan = (try? c.decodeIfPresent([GiaHan].self, forKey: .giaHan)) ?? []
        dtv = c.chuoi(.dtv); ksv = c.chuoi(.ksv); ghiChu = c.chuoi(.ghiChu)
        createdAt = c.so(.createdAt); updatedAt = c.so(.updatedAt)
    }

    var bp: BienPhap {
        get { BienPhap(rawValue: bienPhap) ?? .khac }
        set { bienPhap = newValue.rawValue }
    }
    var gd: GiaiDoan {
        get { GiaiDoan(rawValue: giaiDoan) ?? .dieutra }
        set { giaiDoan = newValue.rawValue }
    }
    var tenVuAn: String {
        let t = vuAn.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Chưa gắn vụ án" : t
    }
    var chuCai: String {
        let last = hoTen.split(separator: " ").last.map(String.init) ?? "?"
        return String(last.prefix(1)).uppercased()
    }
    var tomTat: String {
        let p = [toiDanh, vuAn].filter { !$0.isEmpty }
        if !p.isEmpty { return p.joined(separator: " · ") }
        return ngaySinh.isEmpty ? "" : "Sinh \(Ngay.vn(ngaySinh))"
    }

    /// Hạn tạm giữ / tạm giam đang có hiệu lực (ngày muộn nhất trong lệnh và các lần gia hạn).
    var hanHienTai: String? {
        guard bp.laGiamGiu, gd != .dinhchi else { return nil }
        return ([tgDen] + giaHan.map { $0.den }).filter { !$0.isEmpty }.max()
    }
    func hanInfo(canhBao: Int) -> HanInfo? {
        guard let han = hanHienTai, let con = Ngay.soNgay(tu: Ngay.homNay, den: han) else { return nil }
        return HanInfo(ngay: han, con: con, muc: con <= 0 ? .quaHan : (con <= canhBao ? .sapHet : .binhThuong))
    }
}

struct HanInfo {
    enum Muc { case quaHan, sapHet, binhThuong }
    let ngay: String
    let con: Int
    let muc: Muc
    var text: String {
        if con < 0 { return "Quá hạn \(-con) ngày" }
        if con == 0 { return "Hết hạn hôm nay" }
        return "Còn \(con) ngày"
    }
}

// MARK: - Cài đặt

struct Term: Identifiable, Hashable, Codable {
    var id = UUID()
    var ten: String
    var ngay: Int
}

struct AppSettings: Codable {
    var alertDays = 10
    var terms: [Term] = [
        Term(ten: "Tạm giữ 3 ngày", ngay: 3),
        Term(ten: "1 tháng", ngay: 30),
        Term(ten: "2 tháng", ngay: 60),
        Term(ten: "3 tháng", ngay: 90),
        Term(ten: "4 tháng", ngay: 120),
    ]
    var notifEnabled = false
    var notifShowName = false

    func soNgay(loai: String) -> Int {
        terms.first { $0.ten == loai }?.ngay ?? 0
    }
}

func khongDau(_ s: String) -> String {
    s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        .replacingOccurrences(of: "đ", with: "d")
        .replacingOccurrences(of: "Đ", with: "d")
        .lowercased()
}

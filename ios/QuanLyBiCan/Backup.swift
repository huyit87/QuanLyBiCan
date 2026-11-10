import Foundation
import SwiftUI
import UniformTypeIdentifiers
import CryptoKit
import CommonCrypto
import Security

/// Bản sao lưu mã hoá bằng mật khẩu, cùng định dạng với bản web (.qlbc):
/// PBKDF2-SHA256 -> khoá AES-256-GCM, mỗi hồ sơ là một khối { iv, ct } (ct gồm cả tag 16 byte).
enum Backup {
    struct Box: Codable {
        var iv: String
        var ct: String
    }
    struct File: Codable {
        var app: String
        var v: Int
        var at: String
        var salt: String
        var iter: Int
        var check: Box
        var records: [Box]
    }
    enum Loi: LocalizedError {
        case khongHopLe, saiMatKhau, maHoa
        var errorDescription: String? {
            switch self {
            case .khongHopLe: return "Tệp không phải bản sao lưu hợp lệ."
            case .saiMatKhau: return "Sai mật khẩu bản sao lưu."
            case .maHoa: return "Không mã hoá được dữ liệu."
            }
        }
    }

    static let soVong = 310_000

    static func khoa(matKhau: String, salt: Data, soVong: Int) throws -> SymmetricKey {
        var out = [UInt8](repeating: 0, count: 32)
        let pw = Array(matKhau.utf8).map { Int8(bitPattern: $0) }
        let saltBytes = [UInt8](salt)
        let status = CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2), pw, pw.count, saltBytes, saltBytes.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(soVong), &out, out.count)
        guard Int(status) == Int(kCCSuccess) else { throw Loi.maHoa }
        return SymmetricKey(data: Data(out))
    }

    static func dong(_ data: Data, _ key: SymmetricKey) throws -> Box {
        let sealed = try AES.GCM.seal(data, using: key)
        let iv = sealed.nonce.withUnsafeBytes { Data($0) }
        return Box(iv: iv.base64EncodedString(), ct: (sealed.ciphertext + sealed.tag).base64EncodedString())
    }

    static func mo(_ box: Box, _ key: SymmetricKey) throws -> Data {
        guard let iv = Data(base64Encoded: box.iv), let ct = Data(base64Encoded: box.ct), ct.count >= 16 else {
            throw Loi.khongHopLe
        }
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
        return try AES.GCM.open(sealed, using: key)
    }

    static func xuat(_ records: [BiCan], matKhau: String) throws -> Data {
        var salt = Data(count: 16)
        let rc = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard rc == errSecSuccess else { throw Loi.maHoa }
        let key = try khoa(matKhau: matKhau, salt: salt, soVong: soVong)
        let enc = JSONEncoder()
        let file = File(
            app: "qlbc", v: 1, at: ISO8601DateFormatter().string(from: Date()),
            salt: salt.base64EncodedString(), iter: soVong,
            check: try dong(Data("{\"ok\":true}".utf8), key),
            records: try records.map { try dong(try enc.encode($0), key) })
        return try enc.encode(file)
    }

    static func nhap(_ data: Data, matKhau: String) throws -> [BiCan] {
        guard let file = try? JSONDecoder().decode(File.self, from: data), file.app == "qlbc",
              let salt = Data(base64Encoded: file.salt) else { throw Loi.khongHopLe }
        let key = try khoa(matKhau: matKhau, salt: salt, soVong: file.iter)
        guard (try? mo(file.check, key)) != nil else { throw Loi.saiMatKhau }
        let dec = JSONDecoder()
        return try file.records.map { try dec.decode(BiCan.self, from: try mo($0, key)) }
    }

    // MARK: CSV cho Excel (không mã hoá)

    static func csv(_ records: [BiCan]) -> Data {
        let cols: [(String, (BiCan) -> String)] = [
            ("Họ và tên", { $0.hoTen }), ("Tên gọi khác", { $0.tenKhac }), ("Giới tính", { $0.gioiTinh }),
            ("Ngày sinh", { Ngay.vn($0.ngaySinh) }), ("CCCD", { $0.cccd }), ("Quốc tịch", { $0.quocTich }),
            ("Dân tộc", { $0.danToc }), ("Nghề nghiệp", { $0.ngheNghiep }), ("Nơi thường trú", { $0.hktt }),
            ("Chỗ ở hiện nay", { $0.choO }), ("Tiền án, tiền sự", { $0.tienAn }), ("Vụ án", { $0.vuAn }),
            ("QĐ KTVA số", { $0.soQDKTVA }), ("Ngày KTVA", { Ngay.vn($0.ngayKTVA) }), ("Tội danh", { $0.toiDanh }),
            ("Điều khoản", { $0.dieuKhoan }), ("QĐ KTBC số", { $0.soQDKTBC }), ("Ngày KTBC", { Ngay.vn($0.ngayKTBC) }),
            ("Giai đoạn", { $0.gd.ten }), ("Biện pháp ngăn chặn", { $0.bp.ten }), ("Ngày bắt", { Ngay.vn($0.ngayBat) }),
            ("Nơi giam giữ", { $0.noiGiam }), ("Lệnh số", { $0.soLenh }), ("Loại thời hạn", { $0.loaiHan }),
            ("Từ ngày", { Ngay.vn($0.tgTu) }), ("Đến ngày", { Ngay.vn($0.tgDen) }),
            ("Gia hạn", { r in
                r.giaHan.enumerated().map { "Lần \($0.offset + 1): \($0.element.so) \($0.element.loai) \(Ngay.vn($0.element.tu))-\(Ngay.vn($0.element.den))" }.joined(separator: "; ")
            }),
            ("Hạn hiện tại", { Ngay.vn($0.hanHienTai ?? "") }), ("Điều tra viên", { $0.dtv }),
            ("Kiểm sát viên", { $0.ksv }), ("Ghi chú", { $0.ghiChu }),
        ]
        func o(_ v: String) -> String {
            var s = v
            // Chặn Excel hiểu nội dung là công thức.
            if let c = s.first, "=+-@\t\r".contains(c) { s = "'" + s }
            return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        var lines = [cols.map { o($0.0) }.joined(separator: ",")]
        for r in records.sorted(by: { khongDau($0.hoTen) < khongDau($1.hoTen) }) {
            let cells: [String] = cols.map { col in
                if col.0 == "CCCD", !r.cccd.isEmpty {
                    // Giữ số 0 đầu của CCCD khi mở bằng Excel.
                    return "\"=\"\"" + r.cccd.replacingOccurrences(of: "\"", with: "") + "\"\"\""
                }
                return o(col.1(r))
            }
            lines.append(cells.joined(separator: ","))
        }
        return Data(("\u{FEFF}" + lines.joined(separator: "\r\n")).utf8)
    }
}

struct DataFile: FileDocument {
    static var readableContentTypes: [UTType] = [.json, .commaSeparatedText]
    var data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

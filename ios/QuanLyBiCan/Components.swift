import SwiftUI
import UIKit

extension BiCan {
    var uiImage: UIImage? {
        guard !anh.isEmpty, let comma = anh.firstIndex(of: ","),
              let data = Data(base64Encoded: String(anh[anh.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

enum AnhTien {
    /// Thu nhỏ ảnh (cạnh dài tối đa 480 px) và đổi sang data URL JPEG.
    static func dataURL(from image: UIImage) -> String {
        let maxSide: CGFloat = 480
        let k = min(1, maxSide / max(image.size.width, image.size.height, 1))
        let size = CGSize(width: max(1, image.size.width * k), height: max(1, image.size.height * k))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let jpeg = small.jpegData(compressionQuality: 0.8) else { return "" }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}

struct Avatar: View {
    let r: BiCan
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let img = r.uiImage {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                ZStack {
                    Color(.systemGray5)
                    Text(r.chuCai)
                        .font(.system(size: size * 0.4, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

struct TagView: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

extension HanInfo {
    var color: Color {
        switch muc {
        case .quaHan: return .red
        case .sapHet: return .orange
        case .binhThuong: return .green
        }
    }
}

extension BienPhap {
    var color: Color {
        if laGiamGiu { return .blue }
        if laTaiNgoai { return .green }
        return self == .truyna ? .red : .secondary
    }
}

struct PersonRow: View {
    @EnvironmentObject private var store: Store
    let r: BiCan
    var showHan = false

    var body: some View {
        let han = r.hanInfo(canhBao: store.settings.alertDays)
        HStack(spacing: 12) {
            Avatar(r: r)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.hoTen).font(.body.weight(.semibold)).lineLimit(1)
                if !r.tomTat.isEmpty {
                    Text(r.tomTat).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if showHan, let han {
                    TagView(text: han.text, color: han.color)
                    Text(Ngay.vn(han.ngay)).font(.caption).foregroundStyle(.secondary)
                } else {
                    TagView(text: r.bp.ten, color: r.bp.color)
                    if let han, han.muc != .binhThuong {
                        TagView(text: han.text, color: han.color)
                    }
                }
            }
        }
    }
}

/// Ô nhập có nhãn nhỏ phía trên.
struct Field: View {
    let label: String
    @Binding var text: String
    var multiline = false
    var keyboard: UIKeyboardType = .default
    var capitalization: TextInputAutocapitalization = .sentences

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            if multiline {
                TextField("", text: $text, axis: .vertical).lineLimit(1...6)
            } else {
                TextField("", text: $text)
                    .keyboardType(keyboard)
                    .textInputAutocapitalization(capitalization)
                    .autocorrectionDisabled()
            }
        }
    }
}

/// Chọn ngày, cho phép để trống. Giá trị là chuỗi yyyy-MM-dd.
struct DateRow: View {
    let label: String
    @Binding var iso: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            if let d = Ngay.parse(iso) {
                DatePicker("", selection: Binding(get: { d }, set: { iso = Ngay.iso($0) }), displayedComponents: .date)
                    .labelsHidden()
                Button { iso = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            } else {
                Button("Chọn ngày") { iso = Ngay.homNay }
                    .buttonStyle(.borderless)
            }
        }
    }
}

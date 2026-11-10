import SwiftUI
import PhotosUI

struct FormView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var draft: BiCan
    @State private var photoItem: PhotosPickerItem?

    init(initial: BiCan) {
        _draft = State(initialValue: initial)
    }

    private var isNew: Bool { store.record(draft.id) == nil }
    private var tenHopLe: Bool { !draft.hoTen.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        let terms = store.settings.terms
        Form {
            Section {
                HStack(spacing: 16) {
                    Avatar(r: draft, size: 80)
                    VStack(alignment: .leading, spacing: 10) {
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Text(draft.anh.isEmpty ? "Thêm ảnh" : "Đổi ảnh")
                        }
                        if !draft.anh.isEmpty {
                            Button("Xoá ảnh", role: .destructive) { draft.anh = ""; photoItem = nil }
                        }
                    }
                    .buttonStyle(.borderless)
                }
            }
            Section("Lý lịch") {
                Field(label: "Họ và tên *", text: $draft.hoTen, capitalization: .words)
                Field(label: "Tên gọi khác", text: $draft.tenKhac, capitalization: .words)
                Picker("Giới tính", selection: $draft.gioiTinh) {
                    Text("Nam").tag("Nam")
                    Text("Nữ").tag("Nữ")
                }
                DateRow(label: "Ngày sinh", iso: $draft.ngaySinh)
                Field(label: "Số CCCD", text: $draft.cccd, keyboard: .numberPad)
                Group {
                    Field(label: "Quốc tịch", text: $draft.quocTich)
                    Field(label: "Dân tộc", text: $draft.danToc)
                    Field(label: "Nghề nghiệp", text: $draft.ngheNghiep)
                    Field(label: "Nơi thường trú", text: $draft.hktt, multiline: true)
                    Field(label: "Chỗ ở hiện nay", text: $draft.choO, multiline: true)
                    Field(label: "Tiền án, tiền sự", text: $draft.tienAn, multiline: true)
                }
            }
            Section("Vụ án & tội danh") {
                Field(label: "Tên vụ án", text: $draft.vuAn, multiline: true)
                let goiY = Array(Set(store.records.map { $0.vuAn.trimmingCharacters(in: .whitespacesAndNewlines) }))
                    .filter { !$0.isEmpty && $0 != draft.vuAn }.sorted()
                if !goiY.isEmpty {
                    Menu("Chọn vụ án đã có") {
                        ForEach(goiY, id: \.self) { n in Button(n) { draft.vuAn = n } }
                    }
                }
                Field(label: "QĐ khởi tố vụ án số", text: $draft.soQDKTVA)
                DateRow(label: "Ngày khởi tố vụ án", iso: $draft.ngayKTVA)
                Field(label: "Tội danh", text: $draft.toiDanh, multiline: true)
                Field(label: "Điều, khoản BLHS", text: $draft.dieuKhoan)
                Field(label: "QĐ khởi tố bị can số", text: $draft.soQDKTBC)
                DateRow(label: "Ngày khởi tố bị can", iso: $draft.ngayKTBC)
                Picker("Giai đoạn tố tụng", selection: $draft.gd) {
                    ForEach(GiaiDoan.allCases) { g in Text(g.ten).tag(g) }
                }
            }
            Section {
                Picker("Biện pháp", selection: $draft.bp) {
                    ForEach(BienPhap.allCases) { b in Text(b.ten).tag(b) }
                }
                DateRow(label: "Ngày bắt / tạm giữ", iso: $draft.ngayBat)
                Field(label: "Nơi giam giữ", text: $draft.noiGiam)
                Field(label: "Lệnh / quyết định số", text: $draft.soLenh)
                TermPicker(loai: $draft.loaiHan, terms: terms)
                DateRow(label: "Từ ngày", iso: $draft.tgTu)
                DateRow(label: "Đến ngày", iso: $draft.tgDen)
            } header: {
                Text("Biện pháp ngăn chặn")
            } footer: {
                Text("Chọn loại thời hạn thì \"đến ngày\" tự tính = từ ngày + số ngày − 1. Bảng số ngày sửa trong Cài đặt.")
            }
            ForEach($draft.giaHan) { $g in
                Section {
                    GiaHanEditor(g: $g, terms: terms, settings: store.settings)
                    Button("Xoá lần gia hạn này", role: .destructive) {
                        let gid = g.id
                        draft.giaHan.removeAll { $0.id == gid }
                    }
                } header: {
                    Text("Gia hạn lần \((draft.giaHan.firstIndex { $0.id == g.id } ?? 0) + 1)")
                }
            }
            Section {
                Button("Thêm lần gia hạn") { themGiaHan() }
            }
            Section("Thụ lý & ghi chú") {
                Field(label: "Điều tra viên thụ lý", text: $draft.dtv, capitalization: .words)
                Field(label: "Kiểm sát viên", text: $draft.ksv, capitalization: .words)
                Field(label: "Ghi chú", text: $draft.ghiChu, multiline: true)
            }
        }
        .navigationTitle(isNew ? "Thêm bị can" : "Sửa hồ sơ")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Huỷ") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Lưu") { luu() }.disabled(!tenHopLe)
            }
        }
        .onChange(of: draft.loaiHan) { _, _ in tinhHan() }
        .onChange(of: draft.tgTu) { _, _ in tinhHan() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                    let url = AnhTien.dataURL(from: img)
                    await MainActor.run { draft.anh = url }
                }
            }
        }
    }

    private func tinhHan() {
        let den = Ngay.denNgay(tu: draft.tgTu, soNgay: store.settings.soNgay(loai: draft.loaiHan))
        if !den.isEmpty { draft.tgDen = den }
    }

    private func themGiaHan() {
        var g = GiaHan()
        if let cuoi = ([draft.tgDen] + draft.giaHan.map { $0.den }).filter({ !$0.isEmpty }).max() {
            g.tu = Ngay.congNgay(cuoi, 1)
        }
        draft.giaHan.append(g)
    }

    private func luu() {
        draft.hoTen = draft.hoTen.trimmingCharacters(in: .whitespacesAndNewlines)
        draft.vuAn = draft.vuAn.trimmingCharacters(in: .whitespacesAndNewlines)
        store.upsert(draft)
        dismiss()
    }
}

struct TermPicker: View {
    @Binding var loai: String
    let terms: [Term]

    var body: some View {
        Picker("Loại thời hạn", selection: $loai) {
            Text("Tự nhập đến ngày").tag("")
            ForEach(terms.filter { !$0.ten.isEmpty }) { t in
                Text("\(t.ten) — \(t.ngay) ngày").tag(t.ten)
            }
            if !loai.isEmpty && !terms.contains(where: { $0.ten == loai }) {
                Text(loai).tag(loai)
            }
        }
    }
}

struct GiaHanEditor: View {
    @Binding var g: GiaHan
    let terms: [Term]
    let settings: AppSettings

    var body: some View {
        Group {
            Field(label: "Lệnh / quyết định số", text: $g.so)
            TermPicker(loai: $g.loai, terms: terms)
            DateRow(label: "Từ ngày", iso: $g.tu)
            DateRow(label: "Đến ngày", iso: $g.den)
        }
        .onChange(of: g.loai) { _, _ in tinh() }
        .onChange(of: g.tu) { _, _ in tinh() }
    }

    private func tinh() {
        let den = Ngay.denNgay(tu: g.tu, soNgay: settings.soNgay(loai: g.loai))
        if !den.isEmpty { g.den = den }
    }
}

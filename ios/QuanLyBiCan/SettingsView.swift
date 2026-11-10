import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var lock: AppLock

    @State private var matKhau = ""
    @State private var hoiMatKhauXuat = false
    @State private var hoiMatKhauNhap = false
    @State private var duLieuNhap: Data?
    @State private var chonTep = false
    @State private var xuatTep = false
    @State private var tepXuat: DataFile?
    @State private var loaiTep = UTType.json
    @State private var tenTep = ""
    @State private var thongBao = ""
    @State private var hienThongBao = false
    @State private var hoiXoaHet = false

    var body: some View {
        Form {
            Section("Cảnh báo") {
                Stepper("Cảnh báo trước \(store.settings.alertDays) ngày", value: $store.settings.alertDays, in: 1...60)
                Toggle("Thông báo nhắc hạn lúc 8 giờ", isOn: $store.settings.notifEnabled)
                    .onChange(of: store.settings.notifEnabled) { _, on in
                        if on { store.requestNotificationPermission() }
                    }
                if store.settings.notifEnabled {
                    Toggle("Hiện họ tên bị can trong thông báo", isOn: $store.settings.notifShowName)
                }
            }

            Section {
                ForEach($store.settings.terms) { $t in
                    HStack {
                        TextField("Tên loại thời hạn", text: $t.ten)
                        TextField("Số ngày", value: $t.ngay, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 60)
                        Text("ngày").foregroundStyle(.secondary)
                    }
                }
                .onDelete { store.settings.terms.remove(atOffsets: $0) }
                Button("Thêm loại thời hạn") { store.settings.terms.append(Term(ten: "", ngay: 30)) }
                Button("Đặt lại mặc định") { store.settings.terms = AppSettings().terms }
            } header: {
                Text("Bảng thời hạn (loại → số ngày)")
            } footer: {
                Text("Đến ngày = từ ngày + số ngày − 1 (tính cả ngày bắt đầu). Vuốt sang trái để xoá một dòng. Sửa bảng không làm thay đổi các hồ sơ đã lưu.")
            }

            Section {
                Button("Xuất bản sao lưu (mã hoá bằng mật khẩu)") {
                    matKhau = ""
                    hoiMatKhauXuat = true
                }
                .disabled(store.records.isEmpty)
                .alert("Đặt mật khẩu cho bản sao lưu", isPresented: $hoiMatKhauXuat) {
                    SecureField("Mật khẩu (ít nhất 6 ký tự)", text: $matKhau)
                    Button("Xuất") { xuatSaoLuu() }
                    Button("Huỷ", role: .cancel) { matKhau = "" }
                } message: {
                    Text("Cần mật khẩu này để khôi phục. Quên mật khẩu thì không mở được bản sao lưu.")
                }

                Button("Khôi phục từ bản sao lưu") { chonTep = true }
                    .fileImporter(isPresented: $chonTep, allowedContentTypes: [.json, .data]) { result in
                        docTep(result)
                    }
                    .alert("Mật khẩu của bản sao lưu", isPresented: $hoiMatKhauNhap) {
                        SecureField("Mật khẩu", text: $matKhau)
                        Button("Khôi phục") { nhapSaoLuu() }
                        Button("Huỷ", role: .cancel) { matKhau = ""; duLieuNhap = nil }
                    }

                Button("Xuất danh sách ra Excel (CSV, không mã hoá)") {
                    tepXuat = DataFile(data: Backup.csv(store.records))
                    loaiTep = .commaSeparatedText
                    tenTep = "danh-sach-bi-can-\(Ngay.homNay)"
                    xuatTep = true
                }
                .disabled(store.records.isEmpty)
            } header: {
                Text("Sao lưu")
            } footer: {
                Text("Bản sao lưu dùng chung định dạng với bản web của ứng dụng.")
            }

            Section {
                Button("Khoá ứng dụng ngay") { lock.lockNow() }
                Button("Xoá toàn bộ dữ liệu", role: .destructive) { hoiXoaHet = true }
                    .confirmationDialog("Xoá TOÀN BỘ hồ sơ trên máy này? Không thể hoàn tác.", isPresented: $hoiXoaHet, titleVisibility: .visible) {
                        Button("Xoá toàn bộ", role: .destructive) { store.deleteAll() }
                        Button("Huỷ", role: .cancel) {}
                    }
            } header: {
                Text("Bảo mật")
            } footer: {
                Text("Dữ liệu chỉ lưu trên máy này, được iOS mã hoá khi máy khoá. Ứng dụng mở bằng Face ID / mật mã máy và tự khoá sau 1 phút rời khỏi màn hình.\n\(store.records.count) hồ sơ · phiên bản 1.0")
            }
        }
        .navigationTitle("Cài đặt")
        .fileExporter(isPresented: $xuatTep, document: tepXuat, contentType: loaiTep, defaultFilename: tenTep) { result in
            tepXuat = nil
            if case .failure(let e) = result { bao("Không lưu được tệp: \(e.localizedDescription)") }
        }
        .alert(thongBao, isPresented: $hienThongBao) {
            Button("OK", role: .cancel) {}
        }
    }

    private func bao(_ s: String) {
        thongBao = s
        // Chờ hộp thoại trước đóng hẳn rồi mới hiện thông báo.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { hienThongBao = true }
    }

    private func xuatSaoLuu() {
        let mk = matKhau
        matKhau = ""
        guard mk.count >= 6 else { bao("Mật khẩu cần ít nhất 6 ký tự."); return }
        do {
            tepXuat = DataFile(data: try Backup.xuat(store.records, matKhau: mk))
            loaiTep = .json
            tenTep = "bican-saoluu-\(Ngay.homNay)"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { xuatTep = true }
        } catch {
            bao(error.localizedDescription)
        }
    }

    private func docTep(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { bao("Không đọc được tệp."); return }
        duLieuNhap = data
        matKhau = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { hoiMatKhauNhap = true }
    }

    private func nhapSaoLuu() {
        let mk = matKhau
        matKhau = ""
        guard let data = duLieuNhap else { return }
        duLieuNhap = nil
        do {
            let kq = store.merge(try Backup.nhap(data, matKhau: mk))
            bao("Đã khôi phục: thêm \(kq.them), cập nhật \(kq.capNhat) hồ sơ.")
        } catch {
            bao(error.localizedDescription)
        }
    }
}

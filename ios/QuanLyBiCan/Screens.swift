import SwiftUI

// MARK: - Tổng quan

struct HomeView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var lock: AppLock

    var body: some View {
        let days = store.settings.alertDays
        let chuY = store.canChuY
        let tiepTheo = store.records
            .filter { $0.hanInfo(canhBao: days)?.muc == .binhThuong }
            .sorted { ($0.hanHienTai ?? "") < ($1.hanHienTai ?? "") }
        List {
            if let err = store.loadError {
                Section { Text(err).foregroundStyle(.red) }
            }
            Section {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    StatCard(value: store.records.count, label: "Tổng số bị can")
                    StatCard(value: store.records.filter { $0.bp.laGiamGiu && $0.gd != .dinhchi }.count, label: "Đang tạm giữ, tạm giam")
                    StatCard(value: store.records.filter { $0.bp.laTaiNgoai }.count, label: "Tại ngoại")
                    StatCard(value: store.records.filter { $0.bp == .truyna }.count, label: "Đang truy nã", highlight: true)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section("Hạn tạm giữ, tạm giam cần chú ý (\(chuY.count))") {
                if chuY.isEmpty {
                    Text("Không có hạn nào quá hạn hoặc sắp hết trong \(days) ngày tới.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(chuY) { r in
                        NavigationLink(value: Route.detail(r.id)) { PersonRow(r: r, showHan: true) }
                    }
                }
            }
            if !tiepTheo.isEmpty {
                Section("Các hạn tiếp theo") {
                    ForEach(tiepTheo) { r in
                        NavigationLink(value: Route.detail(r.id)) { PersonRow(r: r, showHan: true) }
                    }
                }
            }
        }
        .navigationTitle("Quản lý bị can")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { lock.lockNow() } label: { Image(systemName: "lock") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.form(nil)) { Image(systemName: "plus") }
            }
        }
    }
}

struct StatCard: View {
    let value: Int
    let label: String
    var highlight = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(highlight && value > 0 ? Color.red : Color.primary)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Danh sách

enum Loc: String, CaseIterable, Identifiable {
    case tatCa, giam, ngoai, truyNa, dieuTra, xong, dinhChi
    var id: String { rawValue }
    var ten: String {
        switch self {
        case .tatCa: return "Tất cả"
        case .giam: return "Tạm giữ, tạm giam"
        case .ngoai: return "Tại ngoại"
        case .truyNa: return "Truy nã"
        case .dieuTra: return "Đang điều tra"
        case .xong: return "Đã kết thúc điều tra"
        case .dinhChi: return "Đình chỉ, tạm đình chỉ"
        }
    }
    func khop(_ r: BiCan) -> Bool {
        switch self {
        case .tatCa: return true
        case .giam: return r.bp.laGiamGiu
        case .ngoai: return r.bp.laTaiNgoai
        case .truyNa: return r.bp == .truyna
        case .dieuTra: return r.gd == .dieutra
        case .xong: return r.gd == .ketluan || r.gd == .truyto || r.gd == .xetxu
        case .dinhChi: return r.gd == .dinhchi || r.gd == .tamdinhchi
        }
    }
}

struct ListView: View {
    @EnvironmentObject private var store: Store
    @State private var q = ""
    @State private var loc = Loc.tatCa

    private var rows: [BiCan] {
        let key = khongDau(q.trimmingCharacters(in: .whitespaces))
        return store.records
            .filter { loc.khop($0) }
            .filter { r in
                key.isEmpty || khongDau([r.hoTen, r.tenKhac, r.cccd, r.vuAn, r.toiDanh, r.noiGiam, r.dtv].joined(separator: " ")).contains(key)
            }
            .sorted { khongDau($0.hoTen) < khongDau($1.hoTen) }
    }

    var body: some View {
        let rows = self.rows
        List {
            Section {
                if rows.isEmpty {
                    Text(store.records.isEmpty ? "Chưa có bị can nào. Bấm + để thêm." : "Không tìm thấy bị can phù hợp.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(rows) { r in
                        NavigationLink(value: Route.detail(r.id)) { PersonRow(r: r) }
                    }
                }
            } header: {
                Text(loc == .tatCa ? "\(rows.count) bị can" : "\(loc.ten): \(rows.count) bị can")
            }
        }
        .navigationTitle("Bị can")
        .searchable(text: $q, prompt: "Tìm tên, CCCD, vụ án, tội danh")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Lọc", selection: $loc) {
                        ForEach(Loc.allCases) { f in Text(f.ten).tag(f) }
                    }
                } label: {
                    Image(systemName: loc == .tatCa ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.form(nil)) { Image(systemName: "plus") }
            }
        }
    }
}

// MARK: - Vụ án

struct CasesView: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        let groups = Dictionary(grouping: store.records, by: { $0.tenVuAn })
        let names = groups.keys.sorted { khongDau($0) < khongDau($1) }
        List {
            if names.isEmpty {
                Text("Chưa có vụ án nào. Vụ án được tạo tự động theo tên vụ án ghi trong hồ sơ bị can.")
                    .foregroundStyle(.secondary)
            }
            ForEach(names, id: \.self) { name in
                let rs = groups[name] ?? []
                let giam = rs.filter { $0.bp.laGiamGiu }.count
                NavigationLink(value: Route.vuAn(name)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.body.weight(.semibold))
                        Text(giam > 0 ? "\(rs.count) bị can · \(giam) đang giam giữ" : "\(rs.count) bị can")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Vụ án")
    }
}

struct CaseView: View {
    @EnvironmentObject private var store: Store
    let name: String

    var body: some View {
        let rs = store.records.filter { $0.tenVuAn == name }.sorted { khongDau($0.hoTen) < khongDau($1.hoTen) }
        let dau = rs.first { !$0.soQDKTVA.isEmpty || !$0.ngayKTVA.isEmpty }
        List {
            Section {
                Text(name).font(.headline)
                if let dau {
                    Text("QĐ khởi tố vụ án " + soNgayText(dau.soQDKTVA, dau.ngayKTVA))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Section("Bị can (\(rs.count))") {
                ForEach(rs) { r in
                    NavigationLink(value: Route.detail(r.id)) { PersonRow(r: r) }
                }
            }
        }
        .navigationTitle("Vụ án")
        .navigationBarTitleDisplayMode(.inline)
    }
}

func soNgayText(_ so: String, _ ngay: String) -> String {
    var p: [String] = []
    if !so.isEmpty { p.append("số \(so)") }
    if !ngay.isEmpty { p.append("ngày \(Ngay.vn(ngay))") }
    return p.joined(separator: ", ")
}

// MARK: - Chi tiết

struct InfoRow: View {
    let label: String
    let value: String

    var body: some View {
        if !value.isEmpty {
            HStack(alignment: .top) {
                Text(label).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                Text(value).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
        }
    }
}

struct DetailView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var confirmDelete = false

    var body: some View {
        if let r = store.record(id) {
            content(r)
        } else {
            Text("Hồ sơ không còn tồn tại.").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func content(_ r: BiCan) -> some View {
        let han = r.hanInfo(canhBao: store.settings.alertDays)
        List {
            Section {
                VStack(spacing: 8) {
                    Avatar(r: r, size: 96)
                    Text(r.hoTen).font(.title2.bold()).multilineTextAlignment(.center)
                    HStack {
                        TagView(text: r.bp.ten, color: r.bp.color)
                        TagView(text: r.gd.ten)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            if let han {
                Section {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(han.text) — hạn \(r.bp.ten.lowercased()) đến \(Ngay.vn(han.ngay))")
                            .font(.body.weight(.semibold))
                        if !r.noiGiam.isEmpty {
                            Text("Nơi giam giữ: \(r.noiGiam)").font(.subheadline)
                        }
                    }
                    .foregroundStyle(han.color)
                    .listRowBackground(han.color.opacity(0.14))
                }
            }
            Section("Lý lịch") {
                InfoRow(label: "Tên gọi khác", value: r.tenKhac)
                InfoRow(label: "Giới tính", value: r.gioiTinh)
                InfoRow(label: "Ngày sinh", value: Ngay.vn(r.ngaySinh))
                InfoRow(label: "Số CCCD", value: r.cccd)
                InfoRow(label: "Quốc tịch", value: r.quocTich)
                InfoRow(label: "Dân tộc", value: r.danToc)
                InfoRow(label: "Nghề nghiệp", value: r.ngheNghiep)
                InfoRow(label: "Nơi thường trú", value: r.hktt)
                InfoRow(label: "Chỗ ở hiện nay", value: r.choO)
                InfoRow(label: "Tiền án, tiền sự", value: r.tienAn)
            }
            Section("Vụ án & tội danh") {
                InfoRow(label: "Vụ án", value: r.vuAn)
                InfoRow(label: "QĐ khởi tố vụ án", value: soNgayText(r.soQDKTVA, r.ngayKTVA))
                InfoRow(label: "Tội danh", value: r.toiDanh)
                InfoRow(label: "Điều khoản BLHS", value: r.dieuKhoan)
                InfoRow(label: "QĐ khởi tố bị can", value: soNgayText(r.soQDKTBC, r.ngayKTBC))
                InfoRow(label: "Giai đoạn", value: r.gd.ten)
            }
            Section("Biện pháp ngăn chặn") {
                InfoRow(label: "Biện pháp", value: r.bp.ten)
                InfoRow(label: "Ngày bắt / tạm giữ", value: Ngay.vn(r.ngayBat))
                InfoRow(label: "Nơi giam giữ", value: r.noiGiam)
                InfoRow(label: "Lệnh / QĐ số", value: r.soLenh)
                InfoRow(label: "Loại thời hạn", value: r.loaiHan)
                InfoRow(label: "Thời hạn", value: khoang(r.tgTu, r.tgDen))
                ForEach(Array(r.giaHan.enumerated()), id: \.element.id) { i, g in
                    InfoRow(label: "Gia hạn lần \(i + 1)",
                            value: [g.so.isEmpty ? "" : "Số \(g.so)", g.loai, khoang(g.tu, g.den)].filter { !$0.isEmpty }.joined(separator: "\n"))
                }
            }
            if !r.dtv.isEmpty || !r.ksv.isEmpty {
                Section("Thụ lý") {
                    InfoRow(label: "Điều tra viên", value: r.dtv)
                    InfoRow(label: "Kiểm sát viên", value: r.ksv)
                }
            }
            if !r.ghiChu.isEmpty {
                Section("Ghi chú") { Text(r.ghiChu).textSelection(.enabled) }
            }
            Section {
                Button("Xoá hồ sơ này", role: .destructive) { confirmDelete = true }
                    .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Hồ sơ bị can")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.form(r.id)) { Text("Sửa").bold() }
            }
        }
        .confirmationDialog("Xoá hồ sơ bị can \"\(r.hoTen)\"? Không thể hoàn tác.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Xoá hồ sơ", role: .destructive) {
                store.delete(r.id)
                dismiss()
            }
            Button("Huỷ", role: .cancel) {}
        }
    }

    private func khoang(_ tu: String, _ den: String) -> String {
        if tu.isEmpty && den.isEmpty { return "" }
        return "\(tu.isEmpty ? "…" : Ngay.vn(tu)) → \(den.isEmpty ? "…" : Ngay.vn(den))"
    }
}

import SwiftUI

@main
struct QuanLyBiCanApp: App {
    @StateObject private var store = Store()
    @StateObject private var lock = AppLock()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(lock)
                .overlay {
                    if !lock.unlocked {
                        LockView()
                            .environmentObject(lock)
                    } else if phase != .active {
                        // Che nội dung trong màn hình chuyển ứng dụng.
                        CoverView()
                    }
                }
                .onChange(of: phase) { _, p in lock.phaseChanged(p) }
                .environment(\.locale, Locale(identifier: "vi_VN"))
        }
    }
}

struct CoverView: View {
    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 64))
                .foregroundStyle(Color.accentColor)
        }
    }
}

struct LockView: View {
    @EnvironmentObject private var lock: AppLock

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Color.accentColor)
                Text("Quản lý bị can").font(.title2.bold())
                if !lock.message.isEmpty {
                    Text(lock.message).foregroundStyle(.secondary)
                }
                Button("Mở khoá") { lock.authenticate() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            .padding()
        }
        .onAppear { lock.authenticate() }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        TabView {
            NavigationStack { HomeView().modifier(Routes()) }
                .tabItem { Label("Tổng quan", systemImage: "house") }
                .badge(store.canChuY.count)
            NavigationStack { ListView().modifier(Routes()) }
                .tabItem { Label("Bị can", systemImage: "person.2") }
            NavigationStack { CasesView().modifier(Routes()) }
                .tabItem { Label("Vụ án", systemImage: "folder") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Cài đặt", systemImage: "gearshape") }
        }
    }
}

enum Route: Hashable {
    case detail(String)
    case form(String?)
    case vuAn(String)
}

struct Routes: ViewModifier {
    @EnvironmentObject private var store: Store

    func body(content: Content) -> some View {
        content.navigationDestination(for: Route.self) { route in
            switch route {
            case .detail(let id):
                DetailView(id: id)
            case .form(let id):
                FormView(initial: id.flatMap { store.record($0) } ?? BiCan())
            case .vuAn(let name):
                CaseView(name: name)
            }
        }
    }
}

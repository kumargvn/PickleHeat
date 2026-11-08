import SwiftUI

@main
struct PickleHeatApp: App {
    @StateObject private var model = AppModel(service: AppConfig.makeService())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(Theme.lime)
                .task { await model.start() }
                .onOpenURL { model.handle(url: $0) }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            switch model.phase {
            case .launching:
                Theme.ink.ignoresSafeArea().overlay(Image("Logo").resizable().frame(width: 120, height: 120))
            case .signedOut:
                SignInView()
            case .needsDupr:
                DuprConnectView()
            case .ready:
                MainTabs()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.phase)
        .alert("Heads up", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}

struct MainTabs: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TabView(selection: $model.selectedTab) {
            NavigationStack { HomeView() }
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppModel.Tab.home)
            NavigationStack { EventsView() }
                .tabItem { Label("Events", systemImage: "calendar") }
                .tag(AppModel.Tab.events)
            NavigationStack { InsightsView() }
                .tabItem { Label("Insights", systemImage: "chart.bar.fill") }
                .tag(AppModel.Tab.insights)
            NavigationStack { ProfileView() }
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
                .tag(AppModel.Tab.profile)
        }
        .toolbarBackground(Theme.surface, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}

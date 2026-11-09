import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var model: AppModel
    @State private var city = ""
    @State private var distance: Double = 75
    @State private var confirmDelete = false
    @State private var confirmDisconnect = false

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Text(initials).font(Theme.display(18)).foregroundStyle(Theme.ink)
                        .frame(width: 52, height: 52).background(Theme.coral, in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.me?.user.name ?? "").font(Theme.display(20))
                        if let email = model.me?.user.email { Text(email).font(.footnote).foregroundStyle(Theme.muted) }
                    }
                }
            }

            Section {
                Picker("Gender", selection: Binding(
                    get: { model.me?.user.gender ?? "" },
                    set: { g in Task { await model.updateProfile(["gender": g.isEmpty ? NSNull() : g]) } }
                )) {
                    Text("Not set").tag("")
                    Text("Woman").tag("f")
                    Text("Man").tag("m")
                }
            } header: { Text("Player") } footer: { Text("Used to build mixed and MLP lines.") }

            Section {
                row("DUPR ID", model.me?.dupr.duprId ?? "—")
                row("Doubles", ratingText(model.me?.dupr.doublesRating))
                row("Singles", ratingText(model.me?.dupr.singlesRating))
                if let synced = model.me?.dupr.matchesSyncedAt, let d = ISO8601DateFormatter().date(from: synced) {
                    row("Last sync", d.formatted(.relative(presentation: .named)))
                }
                Button("Sync now") { Task { await model.syncDupr() } }
                Button("Disconnect DUPR", role: .destructive) { confirmDisconnect = true }
            } header: { Text("DUPR") } footer: {
                Text("Ratings update automatically when DUPR changes them. Confirmed PickleHeat matches are sent to DUPR for you.")
            }

            Section {
                Button("Use my current location") { Task { await model.useCurrentLocation() } }
                HStack {
                    TextField("Or type a city, e.g. Austin, TX", text: $city).submitLabel(.search)
                        .onSubmit { Task { await model.setHome(city: city) } }
                    if !city.isEmpty { Button("Set") { Task { await model.setHome(city: city) } } }
                }
                VStack(alignment: .leading) {
                    Text("Search within \(Int(distance)) miles")
                    Slider(value: $distance, in: 10...300, step: 5, onEditingChanged: { editing in
                        if !editing { Task { await model.updateProfile(["maxDistanceMiles": distance]) } }
                    })
                }
                ForEach(EventFormat.allCases) { f in
                    Toggle(f.title, isOn: Binding(
                        get: { model.me?.user.formats.contains(f) ?? false },
                        set: { on in
                            var list = model.me?.user.formats ?? []
                            if on { if !list.contains(f) { list.append(f) } } else { list.removeAll { $0 == f } }
                            if !list.isEmpty { Task { await model.updateProfile(["formats": list.map(\.rawValue)]) } }
                        }
                    ))
                }
            } header: { Text("Tournament finder") } footer: {
                Text(model.me?.user.lat != nil ? "Home area set." : "Set your area to get tournament picks.")
            }

            Section {
                if model.me?.payouts.ready == true {
                    Label("Payout account linked", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.lime)
                    if !model.isDemo { Button("Manage payouts on the website") { Task { await model.openOnWeb("payouts") } } }
                } else {
                    Button("Set up payouts on the website") { Task { await model.setUpPayouts() } }
                }
            } header: { Text("Getting paid (organizers)") } footer: {
                Text("Entry fees for your events are paid on the PickleHeat website and go straight to your payout account.")
            }

            Section {
                Link("Privacy Policy", destination: AppConfig.privacyURL)
                Link("Support", destination: AppConfig.supportURL)
                if model.isDemo {
                    Text("Demo mode: sample data on this phone only. Nothing is charged or sent to DUPR.").font(.footnote).foregroundStyle(Theme.muted)
                }
                Button("Sign out") { model.signOut() }
                Button("Delete account", role: .destructive) { confirmDelete = true }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle("Profile")
        .onAppear { distance = model.me?.user.maxDistanceMiles ?? 75 }
        .confirmationDialog("Delete your PickleHeat account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { await model.deleteAccount() } }
        } message: {
            Text("This removes your profile, DUPR link and payout link from PickleHeat. Results already sent to DUPR stay on DUPR.")
        }
        .confirmationDialog("Disconnect DUPR?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await model.disconnectDupr() } }
        } message: {
            Text("You'll need to connect again to see your form and join DUPR events.")
        }
    }

    private var initials: String {
        (model.me?.user.name ?? "?").split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined()
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(Theme.muted).monospacedDigit()
        }
    }
}

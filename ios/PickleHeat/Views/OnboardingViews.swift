import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject var model: AppModel
    @State private var usingEmail = false

    var body: some View {
        VStack(spacing: 26) {
            Spacer()
            Image("Logo").resizable().frame(width: 128, height: 128).clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
            VStack(spacing: 10) {
                Text("PickleHeat").font(Theme.display(44)).tracking(-1)
                Text("Heat Climb leagues, tournaments and\nyour DUPR form, all in one place.")
                    .font(.system(size: 17)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            VStack(alignment: .leading, spacing: 14) {
                feature("flame.fill", Theme.coral, "Form score from your last 8 DUPR matches")
                feature("person.3.fill", Theme.lime, "Heat Climb: heats of 4, rotating partners")
                feature("bubble.left.and.bubble.right.fill", Theme.sky, "Heat chats to set a time and place")
            }
            .padding(.horizontal, 8)
            Spacer()
            SignInWithAppleButton(.signIn) { req in
                req.requestedScopes = [.fullName, .email]
            } onCompletion: { result in
                switch result {
                case let .success(auth):
                    guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                          let data = cred.identityToken, let token = String(data: data, encoding: .utf8)
                    else { model.errorMessage = "Apple didn't return a sign-in token. Please try again."; return }
                    let name = [cred.fullName?.givenName, cred.fullName?.familyName].compactMap { $0 }.joined(separator: " ")
                    // Demo mode has no server to check Apple's token, so it opens the demo account.
                    Task { await model.signIn(identityToken: model.isDemo ? "dev:demo" : token, name: name.isEmpty ? nil : name) }
                case let .failure(error):
                    if (error as? ASAuthorizationError)?.code != .canceled { model.errorMessage = error.localizedDescription }
                }
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            Button("Continue with email") { usingEmail = true }
                .buttonStyle(SecondaryButtonStyle())
                .accessibilityIdentifier("continueWithEmail")

            if model.isDemo {
                Button("Try the demo") { Task { await model.signIn(identityToken: "dev:demo", name: nil) } }
                    .buttonStyle(SecondaryButtonStyle())
                    .accessibilityIdentifier("tryDemo")
            }
            Text("By continuing you agree to the [Privacy Policy](\(AppConfig.privacyURL.absoluteString)).")
                .font(.footnote).foregroundStyle(Theme.muted).tint(Theme.lime)
        }
        .padding(24)
        .screenBackground()
        .overlay { if model.busy { ProgressView().controlSize(.large) } }
        .sheet(isPresented: $usingEmail) { NavigationStack { EmailSignInView() } }
    }

    private func feature(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 14) {
            IconTile(systemName: icon, color: color)
            Text(text).font(.system(size: 15, weight: .medium))
        }
    }
}

/// Email + password sign-in, for players who'd rather not use Sign in with Apple.
/// The same account works on the website.
struct EmailSignInView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var problem: String?

    private var ready: Bool {
        email.contains("@") && password.count >= 8 && (!creating || !name.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        Form {
            Section {
                Picker("", selection: $creating) {
                    Text("Sign in").tag(false)
                    Text("Create account").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            Section {
                if creating {
                    TextField("Your name", text: $name).textContentType(.name)
                }
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(creating ? .newPassword : .password)
            } footer: {
                if creating { Text("Use at least 8 characters.") }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(Theme.coral) }
            }
            Section {
                Button(creating ? "Create account" : "Sign in") { submit() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!ready || model.busy)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .accessibilityIdentifier("emailSubmit")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle(creating ? "Create account" : "Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .onChange(of: creating) { _, _ in problem = nil }
    }

    private func submit() {
        let n = name.trimmingCharacters(in: .whitespaces)
        Task {
            problem = await model.signInWithEmail(email.trimmingCharacters(in: .whitespaces), password: password, createName: creating ? n : nil)
            if problem == nil { dismiss() }
        }
    }
}

/// One-time DUPR link. After this, ratings come in automatically and league/tournament
/// results go back to DUPR once the organizer has reviewed and sent them.
struct DuprConnectView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                Circle().fill(Theme.lime).frame(width: 120, height: 120)
                Image(systemName: "link").font(.system(size: 46, weight: .bold)).foregroundStyle(Theme.ink)
            }
            VStack(spacing: 10) {
                Text("Connect DUPR").font(Theme.display(34))
                Text("One time, about 30 seconds. PickleHeat then keeps your rating up to date and sends your league and tournament scores to DUPR once the organizer has reviewed them.")
                    .font(.system(size: 16)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            VStack(alignment: .leading, spacing: 12) {
                row("arrow.down.circle.fill", Theme.lime, "Your DUPR ratings, reliability and recent matches come in")
                row("arrow.up.circle.fill", Theme.coral, "Scores go to DUPR after the organizer reviews them")
                row("lock.fill", Theme.sky, "You log in on DUPR's own page. PickleHeat never sees your password")
            }
            .card()
            Spacer()
            Button {
                Task { await model.connectDupr() }
            } label: {
                if model.busy { ProgressView().tint(Theme.ink) } else { Text("Connect my DUPR account") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityIdentifier("connectDupr")
            if model.isDemo {
                Text("Demo mode: this links a sample DUPR profile.").font(.footnote).foregroundStyle(Theme.muted)
            }
            Button("Sign out") { model.signOut() }.font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(24)
        .screenBackground()
    }

    private func row(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).font(.system(size: 20))
            Text(text).font(.system(size: 15))
        }
    }
}

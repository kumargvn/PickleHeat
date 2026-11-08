import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Image("Logo").resizable().frame(width: 128, height: 128).clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
            VStack(spacing: 10) {
                Text("PickleHeat").font(Theme.display(44)).tracking(-1)
                Text("Leagues, tournaments and your\nDUPR form, all in one place.")
                    .font(.system(size: 17)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            VStack(alignment: .leading, spacing: 14) {
                feature("chart.line.uptrend.xyaxis", Theme.lime, "Form score from your last 8 DUPR matches")
                feature("trophy.fill", Theme.coral, "Create leagues and tournaments, collect fees")
                feature("mappin.and.ellipse", Theme.sky, "Tournaments near you that fit your rating")
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
                    Task { await model.signIn(identityToken: token, name: name.isEmpty ? nil : name) }
                case let .failure(error):
                    if (error as? ASAuthorizationError)?.code != .canceled { model.errorMessage = error.localizedDescription }
                }
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            if model.isDemo {
                Button("Try the demo") { Task { await model.signIn(identityToken: "demo", name: nil) } }
                    .buttonStyle(SecondaryButtonStyle())
                    .accessibilityIdentifier("tryDemo")
            }
            Text("By continuing you agree to the [Privacy Policy](\(AppConfig.privacyURL.absoluteString)).")
                .font(.footnote).foregroundStyle(Theme.muted).tint(Theme.lime)
        }
        .padding(24)
        .screenBackground()
        .overlay { if model.busy { ProgressView().controlSize(.large) } }
    }

    private func feature(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 14) {
            IconTile(systemName: icon, color: color)
            Text(text).font(.system(size: 15, weight: .medium))
        }
    }
}

/// One-time DUPR link. After this, ratings come in automatically and league/tournament
/// results go back to DUPR without the player doing anything.
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
                Text("One time, about 30 seconds. PickleHeat then keeps your rating up to date and sends your league and tournament scores to DUPR for you.")
                    .font(.system(size: 16)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            VStack(alignment: .leading, spacing: 12) {
                row("arrow.down.circle.fill", Theme.lime, "Your DUPR ratings and recent matches come in")
                row("arrow.up.circle.fill", Theme.coral, "Confirmed PickleHeat match scores go to DUPR")
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

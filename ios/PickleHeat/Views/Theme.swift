import SwiftUI

enum Theme {
    static let ink = Color(hex: 0x0A0F24)
    static let surface = Color(hex: 0x141B38)
    static let surface2 = Color(hex: 0x1C2550)
    static let line = Color(hex: 0x2A3466)
    static let text = Color(hex: 0xF4F6FF)
    static let muted = Color(hex: 0xA9B1D6)
    static let lime = Color(hex: 0xD4FF3A)
    static let coral = Color(hex: 0xFF6B4A)
    static let sky = Color(hex: 0x5CC8FF)

    static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    static func color(for label: FormLabel) -> Color {
        switch label {
        case .hot, .rising: return lime
        case .steady: return text
        case .cooling, .cold: return coral
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}

struct CardModifier: ViewModifier {
    var padding: CGFloat = 16
    var radius: CGFloat = 20

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
}

extension View {
    func card(padding: CGFloat = 16, radius: CGFloat = 20) -> some View { modifier(CardModifier(padding: padding, radius: radius)) }

    func screenBackground() -> some View {
        background(Theme.ink.ignoresSafeArea())
            .foregroundStyle(Theme.text)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = Theme.lime

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(Theme.ink)
            .background(color.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(Theme.text)
            .background(Theme.surface.opacity(configuration.isPressed ? 0.6 : 1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
}

/// The signature ring: form score 0–100.
struct FormRing: View {
    var score: Int
    var label: String
    var size: CGFloat = 128
    var trackColor: Color = Theme.ink.opacity(0.14)
    var color: Color = Theme.ink

    var body: some View {
        ZStack {
            Circle().stroke(trackColor, lineWidth: size * 0.1)
            Circle()
                .trim(from: 0, to: CGFloat(max(0, min(100, score))) / 100)
                .stroke(color, style: StrokeStyle(lineWidth: size * 0.1, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text("\(score)").font(Theme.display(size * 0.27)).monospacedDigit()
                Text(label.uppercased()).font(.system(size: max(9, size * 0.08), weight: .heavy)).tracking(1.1).lineLimit(1).minimumScaleFactor(0.6)
            }
            .foregroundStyle(color)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Form \(score), \(label)")
    }
}

struct Pill: View {
    var text: String
    var fg: Color = Theme.lime
    var bg: Color = Theme.ink

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(fg)
            .background(bg, in: Capsule())
    }
}

struct SectionHeader: View {
    var title: String
    var action: String?
    var onAction: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(Theme.display(20))
            Spacer()
            if let action, let onAction {
                Button(action, action: onAction).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.lime)
            }
        }
    }
}

struct IconTile: View {
    var systemName: String
    var color: Color

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(Theme.ink)
            .frame(width: 38, height: 38)
            .background(color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

func money(_ cents: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    f.maximumFractionDigits = cents % 100 == 0 ? 0 : 2
    return f.string(from: NSNumber(value: Double(cents) / 100)) ?? "$\(cents / 100)"
}

func ratingText(_ r: Double?) -> String { r.map { String(format: "%.2f", $0) } ?? "—" }

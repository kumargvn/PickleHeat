import Charts
import SwiftUI

struct InsightsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let p = model.formPayload {
                    if let form = p.form {
                        formCard(form)
                    } else {
                        Text("Play at least 3 DUPR matches to unlock your Form score.").card()
                    }
                    stats(p.insights)
                    dna(p.insights.traits)
                    tip(p.insights.tip)
                    recent(p.matches)
                    methodNote
                } else {
                    ProgressView().padding(.top, 80)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .navigationTitle("Form & Insights")
        .refreshable { await model.syncDupr() }
        .task { if model.formPayload == nil { await model.loadForm() } }
    }

    private func formCard(_ f: FormResult) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                FormRing(score: f.score, label: "Form", size: 96, trackColor: Theme.line, color: Theme.color(for: f.label))
                VStack(alignment: .leading, spacing: 4) {
                    Text(headline(f.label)).font(Theme.display(22)).foregroundStyle(Theme.color(for: f.label))
                    Text(summary(f)).font(.system(size: 14)).foregroundStyle(Theme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("PERFORMANCE VS EXPECTED").font(.system(size: 11, weight: .heavy)).tracking(1).foregroundStyle(Theme.muted)
                    Spacer()
                    Text("oldest → newest").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                Chart(Array(f.residuals.reversed().enumerated()), id: \.offset) { item in
                    BarMark(x: .value("Match", item.offset + 1), y: .value("Residual", item.element * 100))
                        .foregroundStyle(item.element >= 0 ? Theme.lime : Theme.coral)
                        .cornerRadius(4)
                }
                .chartXAxis(.hidden)
                .chartYAxis {
                    AxisMarks(values: [-10, 0, 10]) { v in
                        AxisGridLine().foregroundStyle(Theme.line)
                        AxisValueLabel { if let d = v.as(Double.self) { Text("\(d > 0 ? "+" : "")\(Int(d))%") } }
                    }
                }
                .frame(height: 120)
                .accessibilityLabel("Point share above or below what your rating predicts, for each of your last \(f.residuals.count) matches")
            }
        }
        .card()
    }

    private func headline(_ l: FormLabel) -> String {
        switch l {
        case .hot: return "Hot streak"
        case .rising: return "Rising"
        case .steady: return "Steady"
        case .cooling: return "Cooling off"
        case .cold: return "Cold spell"
        }
    }

    private func summary(_ f: FormResult) -> String {
        let pct = Int((abs(f.weightedResidual) * 100).rounded())
        var s = pct == 0 ? "Playing right at your rating." : "Winning \(pct)% \(f.weightedResidual > 0 ? "more" : "fewer") points than your rating predicts."
        if let p = f.previousScore, p != f.score { s += " \(f.score > p ? "Up" : "Down") from \(p) two matches ago." }
        return s
    }

    private func stats(_ i: Insights) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
            stat("Record", i.record.text)
            stat("Point share", "\(Int((i.pointShare * 100).rounded()))%")
            stat("Close games (±2)", i.closeGames.text)
            stat("vs higher-rated", i.vsHigherRated.text)
        }
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
            Text(value).font(Theme.display(26)).monospacedDigit()
        }
        .card(padding: 14, radius: 18)
    }

    private func dna(_ t: Traits) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("PLAYER DNA").font(.system(size: 11, weight: .heavy)).tracking(1).foregroundStyle(Theme.muted)
            trait("Clutch", "Wins tight games", t.clutch)
            trait("Consistency", "Low swing match to match", t.consistency)
            trait("Giant-killer", "Results vs higher DUPR", t.giantKiller)
            trait("Momentum", "Form trend", t.momentum)
        }
        .card()
    }

    private func trait(_ name: String, _ note: String, _ v: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(name).font(.system(size: 14, weight: .semibold))
                Spacer()
                Text(note).font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.line)
                    Capsule().fill(v >= 60 ? Theme.lime : v >= 40 ? Theme.sky : Theme.coral).frame(width: g.size.width * CGFloat(v) / 100)
                }
            }
            .frame(height: 8)
            .accessibilityLabel("\(name) \(v) out of 100")
        }
    }

    private func tip(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lightbulb.fill").foregroundStyle(Theme.sky)
            Text(text).font(.system(size: 14))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.sky.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.sky.opacity(0.35)))
    }

    private func recent(_ matches: [PlayedMatch]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Recent DUPR matches")
            ForEach(matches.prefix(10)) { m in
                HStack(spacing: 12) {
                    Text(m.won ? "W" : "L")
                        .font(Theme.display(16))
                        .frame(width: 34, height: 34)
                        .foregroundStyle(Theme.ink)
                        .background(m.won ? Theme.lime : Theme.coral, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.scoreText).font(.system(size: 15, weight: .semibold)).monospacedDigit()
                        Text([m.partnerName.map { "w/ \($0)" }, m.opponentNames.map { "vs \($0.joined(separator: " & "))" }].compactMap { $0 }.joined(separator: " · "))
                            .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(m.playedAt.formatted(.dateTime.month(.abbreviated).day())).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                .card(padding: 12, radius: 16)
            }
        }
    }

    private var methodNote: some View {
        Text("How Form works: for each of your last 8 DUPR matches, Pickora compares the share of points you won with the share your team's rating gap predicts. Recent matches count more. 50 means playing exactly at your rating.")
            .font(.footnote).foregroundStyle(Theme.muted)
    }
}

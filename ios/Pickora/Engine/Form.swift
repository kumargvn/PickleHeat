import Foundation

/// Form score, win probability and score-based insights.
/// Same math as server/src/domain/form.ts; shared/vectors/form.json keeps the two identical.
enum Form {
    static let window = 8
    static let decay = 0.8
    static let gain = 400.0
    static let minMatches = 3
    private static let pointScale = 4.0
    private static let matchScale = 1.0

    static func expectedPointShare(_ team: Double, _ opponent: Double) -> Double {
        1 / (1 + pow(10, -(team - opponent) / pointScale))
    }

    static func actualPointShare(_ m: PlayedMatch) -> Double {
        let p = m.points
        return p.us + p.them == 0 ? 0.5 : Double(p.us) / Double(p.us + p.them)
    }

    static func label(_ score: Int) -> FormLabel {
        if score >= 75 { return .hot }
        if score >= 60 { return .rising }
        if score >= 40 { return .steady }
        if score >= 25 { return .cooling }
        return .cold
    }

    static func newestFirst(_ matches: [PlayedMatch]) -> [PlayedMatch] {
        matches.sorted { $0.playedAt > $1.playedAt }
    }

    /// JavaScript's Math.round (halves round up), so both platforms agree to the point.
    static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    private static func scoreOf(_ window: [PlayedMatch]) -> (score: Int, residuals: [Double], weighted: Double) {
        let residuals = window.map { actualPointShare($0) - expectedPointShare($0.teamRating, $0.opponentRating) }
        var num = 0.0, den = 0.0, w = 1.0
        for r in residuals {
            num += w * r
            den += w
            w *= decay
        }
        let weighted = den == 0 ? 0 : num / den
        let score = jsRound(min(100, max(0, 50 + weighted * gain)))
        return (score, residuals, weighted)
    }

    static func score(_ matches: [PlayedMatch]) -> FormResult? {
        let sorted = newestFirst(matches)
        let current = Array(sorted.prefix(window))
        guard current.count >= minMatches else { return nil }
        let now = scoreOf(current)
        let older = Array(sorted.dropFirst(2).prefix(window))
        let previous = older.count >= minMatches ? scoreOf(older).score : nil
        return FormResult(score: now.score, label: label(now.score), matchesUsed: current.count, residuals: now.residuals, weightedResidual: now.weighted, previousScore: previous)
    }

    /// Rating bump implied by a form score, damped by half. Form 50 → 0.
    static func ratingBoost(_ form: Int?) -> Double {
        guard let form else { return 0 }
        let r = min(0.45, max(-0.45, (Double(form) - 50) / gain))
        return 0.5 * pointScale * log10((0.5 + r) / (0.5 - r))
    }

    /// Chance that team A beats team B, from ratings and (optionally) current form.
    static func winProbability(_ a: Double, _ b: Double, formA: Int? = nil, formB: Int? = nil) -> Double {
        let ea = a + ratingBoost(formA)
        let eb = b + ratingBoost(formB)
        return 1 / (1 + pow(10, -(ea - eb) / matchScale))
    }

    static func insights(_ matches: [PlayedMatch]) -> Insights {
        let window = Array(newestFirst(matches).prefix(self.window))
        var record = WinLoss(wins: 0, losses: 0)
        var close = WinLoss(wins: 0, losses: 0)
        var higher = WinLoss(wins: 0, losses: 0)
        var us = 0, total = 0
        for m in window {
            let w = m.won
            if w { record.wins += 1 } else { record.losses += 1 }
            if m.opponentRating >= m.teamRating + 0.05 {
                if w { higher.wins += 1 } else { higher.losses += 1 }
            }
            for g in m.games {
                us += g.us
                total += g.us + g.them
                if abs(g.us - g.them) <= 2 && g.us != g.them {
                    if g.us > g.them { close.wins += 1 } else { close.losses += 1 }
                }
            }
        }
        let residuals = window.map { actualPointShare($0) - expectedPointShare($0.teamRating, $0.opponentRating) }
        let n = Double(max(1, residuals.count))
        let mean = residuals.reduce(0, +) / n
        let sd = (residuals.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / n).squareRoot()
        let form = score(matches)
        var momentum = 50
        if let form, let prev = form.previousScore { momentum = clamp(50 + Double(form.score - prev) * 2.5) }
        let traits = Traits(clutch: pct(close), consistency: clamp(100 - sd * 1000), giantKiller: pct(higher), momentum: momentum)
        return Insights(record: record, pointShare: total == 0 ? 0.5 : Double(us) / Double(total), closeGames: close, vsHigherRated: higher, traits: traits, tip: tip(traits, matchCount: window.count))
    }

    private static func pct(_ r: WinLoss) -> Int {
        r.wins + r.losses == 0 ? 50 : jsRound(100 * Double(r.wins) / Double(r.wins + r.losses))
    }

    private static func clamp(_ x: Double) -> Int { jsRound(min(100, max(0, x))) }

    static func tip(_ t: Traits, matchCount: Int) -> String {
        if matchCount < minMatches { return "Play a few more DUPR matches to unlock your insights." }
        let entries: [(String, Int)] = [("clutch", t.clutch), ("consistency", t.consistency), ("giantKiller", t.giantKiller), ("momentum", t.momentum)]
        // Stable sort by value, keeping the original order on ties (matches Array.prototype.sort).
        let sorted = entries.enumerated().sorted { $0.element.1 != $1.element.1 ? $0.element.1 < $1.element.1 : $0.offset < $1.offset }.map(\.element)
        let (weakest, value) = sorted[0]
        if value >= 60 { return "Every part of your game is trending well. Time to try a higher bracket." }
        switch weakest {
        case "clutch": return "Tight games are slipping away. Play higher-percentage shots at 9-all and up."
        case "consistency": return "Your results swing a lot match to match. A steady warm-up routine helps."
        case "giantKiller": return "Stronger teams are getting the better of you. Book a few games one level up to adjust."
        default: return "Your form dipped in the last two matches. Rest up and reset before the next one."
        }
    }
}

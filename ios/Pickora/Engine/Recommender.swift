import Foundation

/// Tournament recommendations. Same logic as server/src/domain/recommend.ts.
enum Recommender {
    static let earthRadiusMiles = 3958.8

    static func distanceMiles(_ lat1: Double, _ lng1: Double, _ lat2: Double, _ lng2: Double) -> Double {
        func rad(_ d: Double) -> Double { d * .pi / 180 }
        let dLat = rad(lat2 - lat1)
        let dLng = rad(lng2 - lng1)
        let a = pow(sin(dLat / 2), 2) + cos(rad(lat1)) * cos(rad(lat2)) * pow(sin(dLng / 2), 2)
        return 2 * earthRadiusMiles * asin(min(1, a.squareRoot()))
    }

    static func days(from: String, to: String) -> Int {
        guard let a = DateText.day(from), let b = DateText.day(to) else { return 0 }
        return Int((b.timeIntervalSince(a) / 86_400).rounded())
    }

    static func rating(_ p: PlayerProfileForRecs, _ format: EventFormat) -> Double? {
        format == .singles ? (p.singlesRating ?? p.doublesRating) : (p.doublesRating ?? p.singlesRating)
    }

    /// 0…1: how well a rating sits in an event's bracket. 1 = upper-middle, the most competitive spot.
    static func bracketFit(_ rating: Double, _ ev: TournamentEvent) -> Double {
        let lo = ev.minRating ?? 0
        let hi = ev.maxRating ?? 8
        if rating < lo - 0.05 || rating > hi + 0.0001 { return 0 }
        if ev.minRating == nil && ev.maxRating == nil { return 0.5 }
        let span = max(0.25, hi - lo)
        let pos = (rating - lo) / span
        return max(0.2, 1 - abs(pos - 0.6) * 1.2)
    }

    static func recommend(_ player: PlayerProfileForRecs, _ listings: [TournamentListing], today: String, limit: Int = 10) -> [Recommendation] {
        var out: [Recommendation] = []
        let hot = (player.form ?? 50) >= 75
        for t in listings {
            let d = days(from: today, to: t.startDate)
            if d < 0 || !t.registrationOpen { continue }
            let dist = distanceMiles(player.lat, player.lng, t.lat, t.lng)
            if dist > player.maxDistanceMiles { continue }

            var best: (ev: TournamentEvent, fit: Double, rating: Double)?
            for ev in t.events {
                guard let r = rating(player, ev.format) else { continue }
                let fit = bracketFit(r, ev) * (player.formats.contains(ev.format) ? 1 : 0.6)
                if fit > 0 && (best == nil || fit > best!.fit) { best = (ev, fit, r) }
            }
            guard let best else { continue }

            let distanceScore = 1 - dist / max(1, player.maxDistanceMiles)
            let dateScore: Double = d < 3 ? 0.3 : d <= 45 ? 1 : max(0.2, 1 - Double(d - 45) / 120)
            let formatScore: Double = player.formats.contains(best.ev.format) ? 1 : 0
            let score = 0.45 * best.fit + 0.3 * distanceScore + 0.15 * dateScore + 0.1 * formatScore

            var reasons: [String] = []
            if best.ev.minRating != nil || best.ev.maxRating != nil {
                let lo = best.ev.minRating.map { String(format: "%.2f", $0) } ?? "open"
                let hi = best.ev.maxRating.map { String(format: "%.2f", $0) } ?? "up"
                reasons.append("Your \(String(format: "%.2f", best.rating)) fits the \(lo)–\(hi) bracket")
            } else {
                reasons.append("Open bracket, no rating cap")
            }
            reasons.append("\(FormEngine.jsRound(dist)) mi away")
            if d <= 14 { reasons.append(d == 0 ? "Starts today" : "Starts in \(d) day\(d == 1 ? "" : "s")") }
            if hot, let maxR = best.ev.maxRating, best.rating + FormEngine.ratingBoost(player.form) > maxR {
                reasons.append("You're in hot form. Consider the next bracket up")
            }
            out.append(Recommendation(tournament: t, event: best.ev, score: Double(FormEngine.jsRound(score * 1000)) / 1000, distanceMiles: Double(FormEngine.jsRound(dist * 10)) / 10, reasons: reasons))
        }
        out.sort { $0.score != $1.score ? $0.score > $1.score : $0.distanceMiles < $1.distanceMiles }
        return Array(out.prefix(limit))
    }
}

/// Calendar-day strings (YYYY-MM-DD) in UTC, the format the API uses.
enum DateText {
    static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func day(_ s: String) -> Date? { formatter.date(from: String(s.prefix(10))) }
    static func string(_ d: Date) -> String { formatter.string(from: d) }
    static func adding(_ days: Int, to s: String) -> String {
        guard let d = day(s) else { return s }
        return string(d.addingTimeInterval(Double(days) * 86_400))
    }

    static func pretty(_ s: String) -> String {
        guard let d = day(s) else { return s }
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE, MMM d"
        return f.string(from: d)
    }
}

import Foundation

/// Round robins, pools, brackets and standings. Same logic as server/src/domain/schedule.ts.
enum Schedule {
    struct Pairing: Codable, Hashable {
        var round: Int
        var home: String
        var away: String
    }

    struct BracketSlot: Codable, Hashable {
        var round: Int
        var slot: Int
        var top: String?
        var bottom: String?
    }

    struct Result: Codable, Hashable {
        struct Game: Codable, Hashable { var home: Int; var away: Int }
        var home: String
        var away: String
        var games: [Game]
    }

    struct Standing: Codable, Hashable, Identifiable {
        var entrant: String
        var played: Int
        var wins: Int
        var losses: Int
        var pointsFor: Int
        var pointsAgainst: Int
        var diff: Int
        var id: String { entrant }
    }

    static func roundRobin(_ entrants: [String]) -> [Pairing] {
        var list = entrants
        guard list.count >= 2 else { return [] }
        let bye = "\u{0000}bye"
        if list.count % 2 == 1 { list.append(bye) }
        let n = list.count
        var out: [Pairing] = []
        var rot = Array(list.dropFirst())
        for r in 0..<(n - 1) {
            let ring = [list[0]] + rot
            for i in 0..<(n / 2) {
                let a = ring[i], b = ring[n - 1 - i]
                if a == bye || b == bye { continue }
                out.append(r % 2 == 0 ? Pairing(round: r + 1, home: a, away: b) : Pairing(round: r + 1, home: b, away: a))
            }
            rot.insert(rot.removeLast(), at: 0)
        }
        return out
    }

    static func snakePools<T>(_ seeded: [T], count: Int) -> [[T]] {
        let k = max(1, count)
        var pools = Array(repeating: [T](), count: k)
        for (i, e) in seeded.enumerated() {
            let lap = i / k
            let j = i % k
            pools[lap % 2 == 0 ? j : k - 1 - j].append(e)
        }
        return pools
    }

    static func eliminationFirstRound(_ seeded: [String]) -> [BracketSlot] {
        guard seeded.count >= 2 else { return [] }
        var size = 1
        while size < seeded.count { size *= 2 }
        var order = [1]
        while order.count < size {
            let m = order.count * 2 + 1
            order = order.flatMap { [$0, m - $0] }
        }
        func at(_ seed: Int) -> String? { seed <= seeded.count ? seeded[seed - 1] : nil }
        return stride(from: 0, to: order.count, by: 2).map { i in
            BracketSlot(round: 1, slot: i / 2 + 1, top: at(order[i]), bottom: at(order[i + 1]))
        }
    }

    static func winner(_ r: Result) -> String {
        var h = 0, a = 0, ph = 0, pa = 0
        for g in r.games {
            ph += g.home
            pa += g.away
            if g.home > g.away { h += 1 } else if g.away > g.home { a += 1 }
        }
        if h != a { return h > a ? r.home : r.away }
        return ph >= pa ? r.home : r.away
    }

    static func standings(_ entrants: [String], _ results: [Result]) -> [Standing] {
        var map: [String: Standing] = [:]
        for e in entrants { map[e] = Standing(entrant: e, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0) }
        for r in results {
            guard var h = map[r.home], var a = map[r.away] else { continue }
            let w = winner(r)
            h.played += 1
            a.played += 1
            for g in r.games {
                h.pointsFor += g.home; h.pointsAgainst += g.away
                a.pointsFor += g.away; a.pointsAgainst += g.home
            }
            if w == r.home { h.wins += 1; a.losses += 1 } else { a.wins += 1; h.losses += 1 }
            map[r.home] = h
            map[r.away] = a
        }
        var rows = entrants.compactMap { map[$0] }.map { s -> Standing in var s = s; s.diff = s.pointsFor - s.pointsAgainst; return s }
        func h2h(_ x: String, _ y: String) -> Int {
            var xw = 0, yw = 0
            for r in results where (r.home == x && r.away == y) || (r.home == y && r.away == x) {
                if winner(r) == x { xw += 1 } else { yw += 1 }
            }
            return yw - xw
        }
        let snapshot = rows
        rows.sort { a, b in
            if a.wins != b.wins { return a.wins > b.wins }
            if snapshot.filter({ $0.wins == a.wins }).count == 2 {
                let h = h2h(a.entrant, b.entrant)
                if h != 0 { return h < 0 }
            }
            if a.diff != b.diff { return a.diff > b.diff }
            if a.pointsFor != b.pointsFor { return a.pointsFor > b.pointsFor }
            return a.entrant < b.entrant
        }
        return rows
    }
}

import XCTest
@testable import Pickora

/// Replays shared/vectors/*.json, which the API's TypeScript code produced.
/// If these fail, the iOS engine and the API disagree: fix one to match the other.
final class EngineTests: XCTestCase {
    private func vector(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: EngineTests.self).url(forResource: name, withExtension: "json"), "missing \(name).json")
        return try Data(contentsOf: url)
    }

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    // MARK: form

    private struct FormFile: Decodable {
        struct Case: Decodable {
            var name: String
            var matches: [PlayedMatch]
            var expected: FormResult?
            var insights: Insights
        }
        struct Win: Decodable {
            var a: Double
            var b: Double
            var formA: Int?
            var formB: Int?
            var p: Double
        }
        var form: [Case]
        var win: [Win]
    }

    func testFormScoresMatchTheAPI() throws {
        let file = try decoder.decode(FormFile.self, from: vector("form"))
        XCTAssertFalse(file.form.isEmpty)
        for c in file.form {
            let got = Form.score(c.matches)
            if let want = c.expected {
                let g = try XCTUnwrap(got, c.name)
                XCTAssertEqual(g.score, want.score, c.name)
                XCTAssertEqual(g.label, want.label, c.name)
                XCTAssertEqual(g.previousScore, want.previousScore, c.name)
                XCTAssertEqual(g.matchesUsed, want.matchesUsed, c.name)
                XCTAssertEqual(g.weightedResidual, want.weightedResidual, accuracy: 1e-9, c.name)
                XCTAssertEqual(g.residuals.count, want.residuals.count, c.name)
                for (a, b) in zip(g.residuals, want.residuals) { XCTAssertEqual(a, b, accuracy: 1e-9, c.name) }
            } else {
                XCTAssertNil(got, c.name)
            }
            XCTAssertEqual(Form.insights(c.matches), c.insights, c.name)
        }
    }

    func testWinProbabilityMatchesTheAPI() throws {
        let file = try decoder.decode(FormFile.self, from: vector("form"))
        for w in file.win {
            XCTAssertEqual(Form.winProbability(w.a, w.b, formA: w.formA, formB: w.formB), w.p, accuracy: 1e-9)
        }
    }

    // MARK: recommendations

    private struct RecFile: Decodable {
        struct Player: Decodable {
            var doublesRating: Double
            var singlesRating: Double
            var form: Int
            var lat: Double
            var lng: Double
            var maxDistanceMiles: Double
            var formats: [EventFormat]
        }
        struct Rec: Decodable {
            var tournamentId: String
            var eventId: String
            var score: Double
            var distanceMiles: Double
            var reasons: [String]
        }
        var today: String
        var player: Player
        var recommendations: [Rec]
    }

    func testRecommendationsMatchTheAPI() throws {
        let file = try decoder.decode(RecFile.self, from: vector("recommend"))
        let p = file.player
        let got = Recommender.recommend(
            PlayerProfileForRecs(doublesRating: p.doublesRating, singlesRating: p.singlesRating, form: p.form, lat: p.lat, lng: p.lng, maxDistanceMiles: p.maxDistanceMiles, formats: p.formats),
            SampleData.shared.tournaments(today: file.today),
            today: file.today
        )
        XCTAssertEqual(got.count, file.recommendations.count)
        for (g, w) in zip(got, file.recommendations) {
            XCTAssertEqual(g.tournament.id, w.tournamentId)
            XCTAssertEqual(g.event.id, w.eventId)
            XCTAssertEqual(g.score, w.score, accuracy: 1e-9)
            XCTAssertEqual(g.distanceMiles, w.distanceMiles, accuracy: 1e-9)
            XCTAssertEqual(g.reasons, w.reasons)
        }
    }

    // MARK: schedule

    private struct ScheduleFile: Decodable {
        struct RR: Decodable { var entrants: [String]; var pairings: [Schedule.Pairing] }
        struct Pools: Decodable { var seeded: [String]; var count: Int; var pools: [[String]] }
        struct Bracket: Decodable { var seeded: [String]; var firstRound: [Schedule.BracketSlot] }
        struct Table: Decodable { var entrants: [String]; var results: [Schedule.Result]; var table: [Schedule.Standing] }
        var roundRobin: RR
        var pools: Pools
        var bracket: Bracket
        var standings: Table
    }

    func testScheduleMatchesTheAPI() throws {
        let f = try decoder.decode(ScheduleFile.self, from: vector("schedule"))
        XCTAssertEqual(Schedule.roundRobin(f.roundRobin.entrants), f.roundRobin.pairings)
        XCTAssertEqual(Schedule.snakePools(f.pools.seeded, count: f.pools.count), f.pools.pools)
        XCTAssertEqual(Schedule.eliminationFirstRound(f.bracket.seeded), f.bracket.firstRound)
        XCTAssertEqual(Schedule.standings(f.standings.entrants, f.standings.results), f.standings.table)
    }

    // MARK: basics

    func testSampleDataLoads() {
        XCTAssertEqual(SampleData.shared.player.doublesRating, 4.12)
        XCTAssertEqual(SampleData.shared.matches(today: "2026-11-07").count, 10)
        XCTAssertFalse(SampleData.shared.tournaments(today: "2026-11-07").isEmpty)
    }

    func testDemoServiceRunsATournament() async throws {
        let service = await DemoService()
        _ = try await service.signIn(identityToken: "demo", name: "Tester")
        _ = try await service.completeDuprConnect()
        let created = try await service.createEvent(EventDraft.sample(kind: .tournament))
        _ = try await service.onboardPayouts()
        let published = try await service.publish(eventID: created.id)
        XCTAssertEqual(published.status, .open)
        let reg = try await service.register(eventID: created.id, partnerDuprID: "DEMO-PK01", teamName: nil)
        XCTAssertEqual(reg.entry.status, .confirmed) // demo checkout completes instantly
        let detail = try await service.event(id: created.id)
        XCTAssertGreaterThanOrEqual(detail.entries.count, 2)
    }
}

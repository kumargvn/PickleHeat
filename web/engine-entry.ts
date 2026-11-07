// Bundled into docs/app/engine.js so the web app runs the exact same Form,
// recommendation and schedule code as the API.  Build: bun run web/build.ts
export { formScore, insights, winProbability, formLabel } from "../server/src/domain/form";
export { recommend, distanceMiles } from "../server/src/domain/recommend";
export { roundRobin, snakePools, standings, eliminationFirstRound } from "../server/src/domain/schedule";
export { sampleMatches, sampleTournaments, samplePlayer, sampleLeagues, addDays } from "../server/src/adapters/sample";

// Builds the demo backend (the real API + seeded demo world, running in a browser engine) for:
//   docs/app/demo-api.js                       web app demo mode
//   ios/PickleHeat/Resources/demo-api.js       iPhone app demo mode (hidden web view)
// Run from the repo root: bun run web/build.ts
import { copyFileSync, mkdirSync } from "node:fs";
const root = import.meta.dir + "/..";
const r = await Bun.build({ entrypoints: [`${root}/server/src/demo/browser.ts`], outdir: `${root}/docs/app`, naming: "demo-api.js", format: "iife", minify: true, target: "browser" });
if (!r.success) {
  console.error(r.logs);
  process.exit(1);
}
mkdirSync(`${root}/ios/PickleHeat/Resources`, { recursive: true });
copyFileSync(`${root}/docs/app/demo-api.js`, `${root}/ios/PickleHeat/Resources/demo-api.js`);
console.log("built docs/app/demo-api.js and ios/PickleHeat/Resources/demo-api.js");

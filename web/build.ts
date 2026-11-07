// Builds docs/app/engine.js from the shared TypeScript domain code.
const r = await Bun.build({ entrypoints: [import.meta.dir + "/engine-entry.ts"], outdir: import.meta.dir + "/../docs/app", naming: "engine.js", format: "esm", minify: false, target: "browser" });
if (!r.success) { console.error(r.logs); process.exit(1); }
console.log("built docs/app/engine.js");

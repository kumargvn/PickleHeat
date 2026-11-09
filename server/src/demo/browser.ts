// The demo backend: the real PickleHeat API running inside a browser page (the web app's demo
// mode, and a hidden web view in the iPhone app). Nothing leaves the device. State is kept in
// localStorage, so the demo remembers what you did.

import { handle } from "../app";
import { buildDeps } from "../deps";
import { MemoryStore } from "../adapters/memoryStore";
import { seedDemo } from "./seed";

const KEY = "pickleheat-demo-v1";
const BASE = "https://demo.pickleheat.app";

const store = new MemoryStore();
const deps = buildDeps(
  { PUBLIC_BASE_URL: BASE, WEB_APP_URL: `${BASE}/app/`, JWT_SECRET: "pickleheat-demo-secret-not-for-production-0001", ALLOW_DEV_AUTH: "true", SAMPLE_TOURNAMENTS: "true", PLATFORM_FEE_BPS: "0" },
  store,
);

let ready: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        const saved = globalThis.localStorage?.getItem(KEY);
        if (saved) {
          store.import(JSON.parse(saved));
          return;
        }
      } catch {
        /* private mode or corrupt snapshot: start fresh */
      }
      await seedDemo(deps);
      save();
    })();
  }
  return ready;
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(store.export()));
  } catch {
    /* storage full or unavailable: the demo still works for this session */
  }
}

export interface DemoResponse {
  status: number;
  body: string;
}

async function call(method: string, path: string, body: string | null, token: string | null): Promise<DemoResponse> {
  await boot();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(BASE + path, { method, headers, body: body && method !== "GET" ? body : undefined }), deps);
  if (method !== "GET") save();
  return { status: res.status, body: await res.text() };
}

async function reset(): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {}
  store.import({});
  ready = null;
  await boot();
}

(globalThis as any).PickleHeatDemo = { call, reset, base: BASE };

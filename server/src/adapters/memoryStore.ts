// In-memory document store: tests, local development, and the on-device demo.
import type { Collection, Doc, Store } from "../ports";

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/** JSON containment, the same rule as Postgres `jsonb @>`. */
export function contains(doc: unknown, match: unknown): boolean {
  if (match === null || typeof match !== "object") return doc === match;
  if (Array.isArray(match)) {
    if (!Array.isArray(doc)) return false;
    return match.every((m) => doc.some((d) => contains(d, m)));
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
  return Object.entries(match as Record<string, unknown>).every(([k, v]) => contains((doc as Record<string, unknown>)[k], v));
}

export class MemoryStore implements Store {
  private data = new Map<string, Map<string, Doc>>();

  collection<T extends Doc>(name: string): Collection<T> {
    let m = this.data.get(name);
    if (!m) {
      m = new Map();
      this.data.set(name, m);
    }
    const map = m;
    return {
      get: async (id) => (map.has(id) ? clone(map.get(id) as T) : null),
      put: async (doc) => {
        map.set(doc.id, clone(doc));
      },
      delete: async (id) => {
        map.delete(id);
      },
      find: async (match) => [...map.values()].filter((d) => contains(d, match)).map((d) => clone(d as T)),
    };
  }

  /** Whole store as JSON (demo persistence). */
  export(): Record<string, Doc[]> {
    const out: Record<string, Doc[]> = {};
    for (const [k, m] of this.data) out[k] = [...m.values()];
    return clone(out);
  }

  import(snapshot: Record<string, Doc[]>): void {
    this.data.clear();
    for (const [k, docs] of Object.entries(snapshot)) this.data.set(k, new Map(docs.map((d) => [d.id, clone(d)])));
  }
}

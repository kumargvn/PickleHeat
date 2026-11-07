// Tiny router and response helpers built on the standard Request/Response API.

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export type Params = Record<string, string>;
export type Handler<C> = (req: Request, ctx: C, params: Params, url: URL) => Promise<Response>;

interface Route<C> {
  method: string;
  parts: string[];
  handler: Handler<C>;
}

export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: string, path: string, handler: Handler<C>): this {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler<C>; params: Params } | null {
    const segs = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params };
    }
    if (pathMatched) throw new HttpError(405, "Method not allowed");
    return null;
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS } });
}

export function html(body: string, status = 200, opts: { frameable?: boolean } = {}): Response {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS };
  // Our pages are never framed by other sites; the stand-in DUPR login is framed by our own connect page.
  headers[opts.frameable ? "content-security-policy" : "x-frame-options"] = opts.frameable ? "frame-ancestors 'self'" : "DENY";
  return new Response(body, { status, headers });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON", "bad_json");
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- validation helpers ----------

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(422, `${field} is required`, "invalid");
  const s = v.trim();
  if (s.length > max) throw new HttpError(422, `${field} is too long`, "invalid");
  return s;
}

export function optStr(v: unknown, field: string, max = 200): string | null {
  return v == null || v === "" ? null : str(v, field, max);
}

export function numIn(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n) || n < min || n > max) throw new HttpError(422, `${field} must be between ${min} and ${max}`, "invalid");
  return n;
}

export function optNumIn(v: unknown, field: string, min: number, max: number): number | null {
  return v == null || v === "" ? null : numIn(v, field, min, max);
}

export function isoDate(v: unknown, field: string): string {
  const s = str(v, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new HttpError(422, `${field} must be YYYY-MM-DD`, "invalid");
  return s;
}

export function oneOf<T extends string>(v: unknown, field: string, options: readonly T[]): T {
  if (typeof v !== "string" || !options.includes(v as T)) throw new HttpError(422, `${field} must be one of ${options.join(", ")}`, "invalid");
  return v as T;
}

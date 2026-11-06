import { LIMITS } from "./limits";

/**
 * CORS: the UI is same-origin, so no CORS headers are sent by default.
 * Browsers on other origins are blocked. To allow specific sites set
 * ALLOWED_ORIGINS="https://a.example,https://b.example".
 * (Vapi calls the webhook server-to-server; CORS doesn't apply to it.)
 */
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Vapi-Secret",
    Vary: "Origin",
  };
}

export function json(req: Request, data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(req), "Access-Control-Max-Age": "86400" } });
}

/**
 * Best-effort client IP. On Vercel `x-forwarded-for` is set by the platform
 * (client-supplied values are overwritten); elsewhere it is spoofable, so
 * treat per-IP limits as best-effort.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export type JsonBody = { ok: true; body: unknown } | { ok: false; status: number; error: string };

/** Read and parse a JSON body, enforcing a size cap. */
export async function readJson(req: Request, maxBytes: number = LIMITS.maxBodyBytes): Promise<JsonBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: "Request too large" };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: "Invalid request body" };
  }
  if (text.length > maxBytes) return { ok: false, status: 413, error: "Request too large" };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}

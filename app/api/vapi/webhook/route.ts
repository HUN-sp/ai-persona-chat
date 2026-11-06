import { json, preflight, readJson, clientIp } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { rateLimit } from "@/lib/rate-limit";
import { handleVapiBody, verifyVapiRequest } from "@/lib/vapi";

export async function POST(req: Request) {
  try {
    if (!verifyVapiRequest(req)) {
      return json(req, { error: "Unauthorized" }, { status: 401 });
    }
    const rl = rateLimit(`webhook:${clientIp(req)}`, LIMITS.webhookPerMinute, 60_000);
    if (!rl.ok) {
      return json(req, { error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
    }

    const parsed = await readJson(req);
    if (!parsed.ok) return json(req, { error: parsed.error }, { status: parsed.status });

    return json(req, await handleVapiBody(parsed.body));
  } catch (error) {
    // Never echo internals (or caller PII) back; the message is logged without the request body.
    console.error("Vapi webhook error:", error instanceof Error ? error.message : "unknown");
    return json(req, { result: "Error: the assistant hit a problem handling that request." }, { status: 500 });
  }
}

/** Health-check — lets you verify the route is deployed: GET /api/vapi/webhook */
export function GET() {
  return Response.json({ status: "ok", route: "/api/vapi/webhook" });
}

/** CORS preflight – only answered for origins listed in ALLOWED_ORIGINS. */
export function OPTIONS(req: Request) {
  return preflight(req);
}

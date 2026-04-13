import { buildIndex } from "@/lib/indexer";

// Called once at startup to warm up the RAG index
export async function GET() {
  try {
    await buildIndex();
    return Response.json({ status: "index ready" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ status: "error", error: msg }, { status: 500 });
  }
}

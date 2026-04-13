export async function register() {
  // Only run on the server (not during client-side bundling)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { buildIndex } = await import("@/lib/indexer");
    console.log("Server startup: building RAG index...");
    try {
      await buildIndex();
      console.log("RAG index ready.");
    } catch (e) {
      console.error("Failed to build RAG index at startup:", e);
    }
  }
}

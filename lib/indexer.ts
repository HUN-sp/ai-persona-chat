import prebuiltIndex from "../data/index.json";

export interface IndexedChunk {
  text: string;
  embedding: number[];
  metadata: {
    source: "github" | "resume";
    repo?: string;
    filePath?: string;
    section?: string;
  };
}

// Use globalThis so the cache survives Next.js hot reloads in dev mode
const g = globalThis as typeof globalThis & { __ragIndex?: IndexedChunk[] };

/**
 * The in-memory RAG index: the statically imported, pre-built data/index.json.
 * To regenerate it from the resume + GitHub run `npm run rebuild-index`
 * (needs COHERE_API_KEY; see scripts/rebuild-index.ts).
 */
export async function buildIndex(): Promise<IndexedChunk[]> {
  if (!g.__ragIndex) {
    g.__ragIndex = prebuiltIndex as IndexedChunk[];
    console.log(`Loaded ${g.__ragIndex.length} chunks from pre-built index.`);
  }
  return g.__ragIndex;
}

export function clearIndex() {
  g.__ragIndex = undefined;
}

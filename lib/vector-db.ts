/**
 * lib/vector-db.ts
 *
 * Pinecone wrapper for the RAG index.
 * Provides upsert (indexing) and query (retrieval) operations.
 *
 * Index config expected in Pinecone dashboard:
 *   Name:       vinay-persona
 *   Dimensions: 1024  (Cohere embed-english-v3.0)
 *   Metric:     cosine
 *   Serverless: AWS us-east-1
 */

import { Pinecone } from "@pinecone-database/pinecone";

// ── Singleton client ────────────────────────────────────────────

let _client: Pinecone | null = null;

function getClient(): Pinecone {
  if (!_client) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error("PINECONE_API_KEY is not set");
    _client = new Pinecone({ apiKey });
  }
  return _client;
}

export const INDEX_NAME = "vinay-persona";

// ── Types ───────────────────────────────────────────────────────

export interface ChunkMetadata {
  text: string;         // full chunk text (stored in metadata for retrieval)
  source: "github" | "resume";
  repo?: string;
  filePath?: string;
  section?: string;
}

export interface UpsertRecord {
  id: string;           // unique chunk ID
  values: number[];     // 1024-dim embedding
  metadata: ChunkMetadata;
}

export interface QueryMatch {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

// ── Upsert (write during indexing) ─────────────────────────────

const UPSERT_BATCH_SIZE = 100; // Pinecone recommends <= 100 per batch

export async function upsertChunks(records: UpsertRecord[]): Promise<void> {
  const index = getClient().index(INDEX_NAME);

  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE);
    const vectors = batch.map((r) => ({
      id: r.id,
      values: r.values,
      metadata: r.metadata as unknown as Record<string, string>,
    }));
    // Pinecone SDK: upsert expects { records: [...] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (index as any).upsert({ records: vectors });
    console.log(`Pinecone upsert: batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1} / ${Math.ceil(records.length / UPSERT_BATCH_SIZE)}`);
  }
}

// ── Query (read during retrieval) ───────────────────────────────

export async function queryChunks(
  queryVector: number[],
  topK = 20
): Promise<QueryMatch[]> {
  const index = getClient().index(INDEX_NAME);

  const response = await index.query({
    vector: queryVector,
    topK,
    includeMetadata: true,
  });

  return (response.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score ?? 0,
    metadata: m.metadata as unknown as ChunkMetadata,
  }));
}

// ── Health check ────────────────────────────────────────────────

export async function getPineconeStats(): Promise<{ totalRecordCount: number }> {
  const index = getClient().index(INDEX_NAME);
  const stats = await index.describeIndexStats();
  return { totalRecordCount: stats.totalRecordCount ?? 0 };
}

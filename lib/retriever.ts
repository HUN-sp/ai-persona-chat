/**
 * lib/retriever.ts
 *
 * RAG retrieval with a two-tier strategy:
 *
 *   Tier 1 (primary):   Pinecone ANN search  +  Cohere cross-encoder rerank
 *   Tier 2 (fallback):  In-memory cosine sim  +  Cohere cross-encoder rerank
 *                       (used when PINECONE_API_KEY is not set OR Pinecone fails)
 *
 * The caller only ever calls retrieve(query, topK) — the strategy is transparent.
 */

import { TtlCache } from "./cache";
import { getCohereClient, EMBED_MODEL, RERANK_MODEL } from "./cohere";
import { buildIndex, IndexedChunk } from "./indexer";
import { queryChunks } from "./vector-db";

// ── Scoring parameters ──────────────────────────────────────────

// Minimum cosine score for a chunk to be used as context – applied to BOTH tiers
// (Pinecone and in-memory use the same embeddings/metric, so scores are comparable).
// Override with RAG_MIN_SCORE to tune without a code change.
const SCORE_THRESHOLD = Number(process.env.RAG_MIN_SCORE) > 0 ? Number(process.env.RAG_MIN_SCORE) : 0.25;
const CANDIDATE_K     = 20;    // candidates to rerank
const PINECONE_CANDIDATE_K = 20; // how many Pinecone results to fetch before reranking

// ── Helpers ─────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Repeated questions (suggested chips, retries, voice re-asks) are common and every
// uncached retrieval costs 1 embed + 1 rerank (+1 Pinecone query). Per-instance, 30 min.
const embeddingCache = new TtlCache<number[]>(200);
const resultCache = new TtlCache<string>(200);
const cacheKey = (query: string) => query.toLowerCase().replace(/\s+/g, " ").trim();

/** Test hook. */
export function clearRetrievalCaches() {
  embeddingCache.clear();
  resultCache.clear();
}

async function embedQuery(query: string): Promise<number[]> {
  const key = cacheKey(query);
  const cached = embeddingCache.get(key);
  if (cached) return cached;
  const vec = await embedQueryUncached(query);
  embeddingCache.set(key, vec);
  return vec;
}

async function embedQueryUncached(query: string): Promise<number[]> {
  const response = await getCohereClient().embed({
    texts: [query],
    model: EMBED_MODEL,
    inputType: "search_query",
  });
  return (response.embeddings as number[][])[0];
}

async function rerank(query: string, docs: string[], topK: number): Promise<string[]> {
  try {
    const reranked = await getCohereClient().rerank({
      model: RERANK_MODEL,
      query,
      documents: docs,
      topN: Math.min(topK, docs.length),
    });
    return reranked.results.map((r) => docs[r.index]);
  } catch (e) {
    console.warn("Cohere rerank failed, using original order:", e instanceof Error ? e.message : "unknown");
    return docs.slice(0, topK);
  }
}


// ── Tier 1: Pinecone ─────────────────────────────────────────────

/**
 * Returns `null` when the Pinecone index returned nothing at all (not populated →
 * caller falls back to the in-memory index), and `""` when it returned matches but
 * none were relevant enough (→ no context; do NOT spend a second embed on fallback).
 */
async function retrieveViaPinecone(query: string, topK: number): Promise<string | null> {
  const queryVector = await embedQuery(query);

  // ANN search in Pinecone (returns pre-ranked by approximate cosine)
  const matches = await queryChunks(queryVector, PINECONE_CANDIDATE_K);
  if (matches.length === 0) return null;

  const docs = matches
    .filter((m) => m.score >= SCORE_THRESHOLD && m.metadata?.text)
    .map((m) => m.metadata.text);
  if (docs.length === 0) return "";

  const reranked = await rerank(query, docs, topK);
  return reranked.join("\n\n---\n\n");
}

// ── Tier 2: In-memory fallback ───────────────────────────────────

async function retrieveViaMemory(query: string, topK: number): Promise<string> {
  const index = await buildIndex();
  if (index.length === 0) return "";

  const queryVector = await embedQuery(query);

  const candidates = index
    .map((chunk: IndexedChunk) => ({
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.embedding),
    }))
    .filter((c) => c.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_K);

  if (candidates.length === 0) return "";

  const docs = candidates.map((c) => c.text);
  const reranked = await rerank(query, docs, topK);
  return reranked.join("\n\n---\n\n");
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Retrieve the top-K most relevant chunks for a query.
 *
 * Uses Pinecone if PINECONE_API_KEY is set and the index has records.
 * Falls back to in-memory cosine search automatically.
 */
export async function retrieve(query: string, topK = 5): Promise<string> {
  const key = `${topK}|${cacheKey(query)}`;
  const cached = resultCache.get(key);
  if (cached !== undefined) return cached;

  const result = await retrieveUncached(query, topK);
  resultCache.set(key, result); // errors throw above and are never cached; "" (nothing relevant) is cached
  return result;
}

async function retrieveUncached(query: string, topK: number): Promise<string> {
  const hasPinecone = !!process.env.PINECONE_API_KEY;

  if (hasPinecone) {
    try {
      const result = await retrieveViaPinecone(query, topK);
      if (result !== null) return result; // "" = nothing relevant: legitimately no context
      // null = Pinecone index not yet populated — fall through
      console.warn("[RAG] Pinecone index is empty, falling back to in-memory");
    } catch (e) {
      console.error("[RAG] Pinecone retrieval failed, falling back to in-memory:", e instanceof Error ? e.message : "unknown");
    }
  }

  return retrieveViaMemory(query, topK);
}

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

import { CohereClient } from "cohere-ai";
import { buildIndex, IndexedChunk } from "./indexer";
import { queryChunks } from "./vector-db";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY ?? process.env.CO_API_KEY });

// ── Scoring parameters ──────────────────────────────────────────

const SCORE_THRESHOLD = 0.25;  // minimum cosine score (fallback path only)
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

async function embedQuery(query: string): Promise<number[]> {
  const response = await cohere.embed({
    texts: [query],
    model: "embed-english-v3.0",
    inputType: "search_query",
  });
  return (response.embeddings as number[][])[0];
}

async function rerank(query: string, docs: string[], topK: number): Promise<string[]> {
  try {
    const reranked = await cohere.rerank({
      model: "rerank-english-v3.0",
      query,
      documents: docs,
      topN: Math.min(topK, docs.length),
    });
    return reranked.results.map((r) => docs[r.index]);
  } catch (e) {
    console.warn("Cohere rerank failed, using original order:", e);
    return docs.slice(0, topK);
  }
}

// ── Tier 1: Pinecone ─────────────────────────────────────────────

async function retrieveViaPinecone(query: string, topK: number): Promise<string> {
  const queryVector = await embedQuery(query);

  // ANN search in Pinecone (returns pre-ranked by approximate cosine)
  const matches = await queryChunks(queryVector, PINECONE_CANDIDATE_K);

  if (matches.length === 0) return "";

  const docs = matches
    .filter((m) => m.metadata?.text)
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
  const hasPinecone = !!process.env.PINECONE_API_KEY;

  if (hasPinecone) {
    try {
      console.log("[RAG] Using Pinecone retrieval");
      const result = await retrieveViaPinecone(query, topK);
      if (result) return result;
      // Empty result = Pinecone index not yet populated — fall through
      console.warn("[RAG] Pinecone returned no results, falling back to in-memory");
    } catch (e) {
      console.error("[RAG] Pinecone retrieval failed, falling back to in-memory:", e);
    }
  }

  console.log("[RAG] Using in-memory retrieval");
  return retrieveViaMemory(query, topK);
}

import { CohereClient } from "cohere-ai";
import { buildIndex, IndexedChunk } from "./indexer";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY ?? process.env.CO_API_KEY });

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Minimum cosine score to even be considered — filters out truly irrelevant chunks
const SCORE_THRESHOLD = 0.25;
// How many candidates to pull before reranking (wider net → better recall)
const CANDIDATE_K = 20;

export async function retrieve(query: string, topK = 5): Promise<string> {
  const index = await buildIndex();
  if (index.length === 0) return "";

  // 1. Embed the query
  const response = await cohere.embed({
    texts: [query],
    model: "embed-english-v3.0",
    inputType: "search_query",
  });
  const queryEmbedding = (response.embeddings as number[][])[0];

  // 2. Cosine similarity → filter by threshold → take top CANDIDATE_K
  const candidates = index
    .map((chunk: IndexedChunk) => ({
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .filter((c) => c.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_K);

  if (candidates.length === 0) return "";

  // 3. Rerank with Cohere cross-encoder for precise ordering
  try {
    const docs = candidates.map((c) => c.text);
    const reranked = await cohere.rerank({
      model: "rerank-english-v3.0",
      query,
      documents: docs,
      topN: Math.min(topK, docs.length),
    });

    return reranked.results
      .map((r) => docs[r.index])
      .join("\n\n---\n\n");
  } catch (e) {
    // Rerank failed (rate limit, etc.) — fall back to cosine-ranked results
    console.warn("Cohere rerank failed, falling back to cosine ranking:", e);
    return candidates
      .slice(0, topK)
      .map((c) => c.text)
      .join("\n\n---\n\n");
  }
}

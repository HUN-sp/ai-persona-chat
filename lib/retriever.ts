import { CohereClient } from "cohere-ai";
import { buildIndex, IndexedChunk } from "./indexer";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieve(query: string, topK = 5): Promise<string> {
  const index = await buildIndex();
  if (index.length === 0) return "";

  // Embed the query
  const response = await cohere.embed({
    texts: [query],
    model: "embed-english-v3.0",
    inputType: "search_query",
  });
  const queryEmbedding = (response.embeddings as number[][])[0];

  // Score all chunks
  const scored = index.map((chunk: IndexedChunk) => ({
    text: chunk.text,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // Return top-K chunks as context string
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((c) => c.text)
    .join("\n\n---\n\n");
}

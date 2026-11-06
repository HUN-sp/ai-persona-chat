import { CohereClient } from "cohere-ai";

export const EMBED_MODEL = "embed-english-v3.0";
export const RERANK_MODEL = "rerank-english-v3.0";

let _cohere: CohereClient | null = null;

/** Shared lazy Cohere client (COHERE_API_KEY, or CO_API_KEY as used by SDK v7+). */
export function getCohereClient(): CohereClient {
  if (!_cohere) {
    _cohere = new CohereClient({ token: process.env.COHERE_API_KEY ?? process.env.CO_API_KEY });
  }
  return _cohere;
}

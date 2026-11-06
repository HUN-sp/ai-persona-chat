import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  embed: vi.fn(),
  rerank: vi.fn(),
  queryChunks: vi.fn(),
  buildIndex: vi.fn(),
}));

vi.mock("cohere-ai", () => ({
  CohereClient: class {
    embed = h.embed;
    rerank = h.rerank;
  },
}));
vi.mock("@/lib/vector-db", () => ({ queryChunks: h.queryChunks }));
vi.mock("@/lib/indexer", () => ({ buildIndex: h.buildIndex }));

import { retrieve, clearRetrievalCaches } from "@/lib/retriever";

const idx = [
  { text: "HFT chunk", embedding: [1, 0], metadata: { source: "resume" } },
  { text: "Spring chunk", embedding: [0.8, 0.6], metadata: { source: "resume" } },
  { text: "Unrelated chunk", embedding: [0, 1], metadata: { source: "github" } },
];

function query(vec: number[]) {
  h.embed.mockResolvedValue({ embeddings: [vec] });
}

beforeEach(() => {
  clearRetrievalCaches();
  h.buildIndex.mockResolvedValue(idx);
  h.rerank.mockImplementation(async ({ documents, topN }: { documents: string[]; topN: number }) => ({
    results: documents.slice(0, topN).map((_, index) => ({ index })),
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("in-memory tier", () => {
  it("returns relevant chunks, reranked", async () => {
    query([1, 0]);
    const out = await retrieve("hft?", 2);
    expect(out).toContain("HFT chunk");
    expect(out).not.toContain("Unrelated chunk"); // cosine 0 < threshold
  });

  it("returns nothing for an off-topic query (all below threshold)", async () => {
    query([-1, -1]);
    expect(await retrieve("capital of france", 5)).toBe("");
    expect(h.rerank).not.toHaveBeenCalled();
  });
});

describe("Pinecone tier (RAG-1)", () => {
  beforeEach(() => vi.stubEnv("PINECONE_API_KEY", "pk-test"));

  it("applies the same score threshold – off-topic queries get no context", async () => {
    query([1, 0]);
    h.queryChunks.mockResolvedValue([
      { id: "a", score: 0.12, metadata: { text: "weak match A" } },
      { id: "b", score: 0.2, metadata: { text: "weak match B" } },
    ]);
    expect(await retrieve("capital of france", 5)).toBe("");
    expect(h.rerank).not.toHaveBeenCalled();
    // no second embed from a pointless in-memory fallback
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.buildIndex).not.toHaveBeenCalled();
  });

  it("keeps only chunks at/above threshold and reranks them", async () => {
    query([1, 0]);
    h.queryChunks.mockResolvedValue([
      { id: "a", score: 0.61, metadata: { text: "good A" } },
      { id: "b", score: 0.1, metadata: { text: "junk" } },
      { id: "c", score: 0.4, metadata: { text: "good C" } },
    ]);
    const out = await retrieve("hft", 5);
    expect(out).toBe("good A\n\n---\n\ngood C");
    expect(h.rerank.mock.calls[0][0].documents).toEqual(["good A", "good C"]);
  });

  it("falls back to memory only when the Pinecone index is empty", async () => {
    query([1, 0]);
    h.queryChunks.mockResolvedValue([]);
    expect(await retrieve("hft", 2)).toContain("HFT chunk");
    expect(h.buildIndex).toHaveBeenCalled();
  });

  it("falls back to memory when Pinecone errors", async () => {
    query([1, 0]);
    h.queryChunks.mockRejectedValue(new Error("pinecone down"));
    expect(await retrieve("hft", 2)).toContain("HFT chunk");
  });

  it("RAG_MIN_SCORE tunes the threshold", async () => {
    vi.resetModules();
    vi.stubEnv("RAG_MIN_SCORE", "0.9");
    const { retrieve: r2 } = await import("@/lib/retriever");
    query([1, 0]);
    h.queryChunks.mockResolvedValue([{ id: "a", score: 0.6, metadata: { text: "mid" } }]);
    expect(await r2("hft", 5)).toBe("");
  });
});

describe("rerank failure", () => {
  it("degrades to the similarity order instead of failing the chat", async () => {
    query([1, 0]);
    h.rerank.mockRejectedValue(new Error("rerank 500"));
    expect(await retrieve("hft", 1)).toContain("HFT chunk");
  });
});

describe("retrieval caching (PERF-1)", () => {
  it("a repeated question costs zero Cohere calls the second time", async () => {
    query([1, 0]);
    const a = await retrieve("What is your CGPA?", 5);
    const calls = [h.embed.mock.calls.length, h.rerank.mock.calls.length];
    const b = await retrieve("  what is   your cgpa? ", 5); // normalised key
    expect(b).toBe(a);
    expect([h.embed.mock.calls.length, h.rerank.mock.calls.length]).toEqual(calls);
    expect(calls).toEqual([1, 1]);
  });

  it("caches 'nothing relevant' too (off-topic retries are free)", async () => {
    query([-1, -1]);
    await retrieve("capital of france", 5);
    await retrieve("capital of france", 5);
    expect(h.embed).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure", async () => {
    h.embed.mockRejectedValueOnce(new Error("cohere 500"));
    await expect(retrieve("hft", 2)).rejects.toThrow();
    query([1, 0]);
    expect(await retrieve("hft", 2)).toContain("HFT chunk");
  });
});

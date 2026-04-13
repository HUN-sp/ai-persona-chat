import { CohereClient } from "cohere-ai";
import { fetchGitHubChunks, CodeChunk } from "./github";
import { fetchResumeChunks, ResumeChunk } from "./resume";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

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


function chunkToText(chunk: CodeChunk | ResumeChunk): string {
  if (chunk.source === "github") {
    const c = chunk as CodeChunk;
    return `[repo: ${c.repo}] [file: ${c.filePath}]\n\n${c.content}`;
  } else {
    const c = chunk as ResumeChunk;
    return `[resume section: ${c.section}]\n\n${c.content}`;
  }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await cohere.embed({
    texts,
    model: "embed-english-v3.0",
    inputType: "search_document",
  });
  return response.embeddings as number[][];
}

export async function buildIndex(): Promise<IndexedChunk[]> {
  if (g.__ragIndex) return g.__ragIndex;

  console.log("Building RAG index...");

  const [githubChunks, resumeChunks] = await Promise.all([
    fetchGitHubChunks(),
    Promise.resolve(fetchResumeChunks()),
  ]);

  const allChunks = [...githubChunks, ...resumeChunks];
  const texts = allChunks.map(chunkToText);

  // Embed in batches of 20 with delay to avoid Cohere trial rate limit
  const BATCH_SIZE = 20;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    allEmbeddings.push(...embeddings);
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 1000)); // 1s pause between batches
    }
  }

  g.__ragIndex = allChunks.map((chunk, i) => ({
    text: texts[i],
    embedding: allEmbeddings[i],
    metadata: {
      source: chunk.source,
      ...(chunk.source === "github"
        ? { repo: (chunk as CodeChunk).repo, filePath: (chunk as CodeChunk).filePath }
        : { section: (chunk as ResumeChunk).section }),
    },
  }));

  console.log(`Index built: ${g.__ragIndex.length} chunks`);
  return g.__ragIndex;
}

export function clearIndex() {
  g.__ragIndex = undefined;
}

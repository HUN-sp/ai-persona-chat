/**
 * OFFLINE index builder – used by `npm run rebuild-index` only.
 * (Kept out of lib/indexer.ts so GitHub/Cohere index-time code is not part of the
 * server bundle; at runtime the pre-built data/index.json is all that is loaded.)
 */

import { getCohereClient, EMBED_MODEL } from "./cohere";
import { fetchGitHubChunks, type CodeChunk } from "./github";
import { fetchResumeChunks, type ResumeChunk } from "./resume";
import type { IndexedChunk } from "./indexer";

function chunkToText(chunk: CodeChunk | ResumeChunk): string {
  if (chunk.source === "github") {
    const c = chunk as CodeChunk;
    return `[repo: ${c.repo}] [file: ${c.filePath}]\n\n${c.content}`;
  }
  const c = chunk as ResumeChunk;
  return `[resume section: ${c.section}]\n\n${c.content}`;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await getCohereClient().embed({
    texts,
    model: EMBED_MODEL,
    inputType: "search_document",
  });
  return response.embeddings as number[][];
}

/** Fetch GitHub + resume chunks and embed them with Cohere (paid calls!). */
export async function buildFreshIndex(log: (m: string) => void = console.log): Promise<IndexedChunk[]> {
  const [githubChunks, resumeChunks] = await Promise.all([fetchGitHubChunks(), Promise.resolve(fetchResumeChunks())]);
  if (githubChunks.length === 0 || resumeChunks.length === 0) {
    // Never overwrite a good index with a partial one.
    throw new Error(`Refusing to build: got ${githubChunks.length} GitHub and ${resumeChunks.length} resume chunks`);
  }
  const allChunks = [...githubChunks, ...resumeChunks];
  const texts = allChunks.map(chunkToText);
  log(`Embedding ${texts.length} chunks with Cohere…`);

  // Batches of 20 with a pause to stay under Cohere trial-key rate limits.
  const BATCH_SIZE = 20;
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    embeddings.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
    log(`  embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`);
    if (i + BATCH_SIZE < texts.length) await new Promise((r) => setTimeout(r, 1000));
  }

  return allChunks.map((chunk, i) => ({
    text: texts[i],
    embedding: embeddings[i],
    metadata: {
      source: chunk.source,
      ...(chunk.source === "github"
        ? { repo: (chunk as CodeChunk).repo, filePath: (chunk as CodeChunk).filePath }
        : { section: (chunk as ResumeChunk).section }),
    },
  }));
}

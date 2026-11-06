/**
 * Seed (or refresh) the Pinecone index from data/index.json. No embedding calls –
 * it re-uses the vectors already in the file, so it only needs PINECONE_API_KEY.
 *
 *   npm run seed-pinecone
 *
 * Creates the serverless index `vinay-persona` (1024-d, cosine, aws/us-east-1) if missing.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Pinecone } from "@pinecone-database/pinecone";

config({ path: join(process.cwd(), ".env.local") });

async function main() {
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    console.error("PINECONE_API_KEY is not set (put it in .env.local). Nothing was changed.");
    process.exit(1);
  }
  const { INDEX_NAME, upsertChunks } = await import("../lib/vector-db");
  type Chunk = { text: string; embedding: number[]; metadata: { source: "github" | "resume"; repo?: string; filePath?: string; section?: string } };
  const chunks: Chunk[] = JSON.parse(readFileSync(join(process.cwd(), "data", "index.json"), "utf-8"));

  const pc = new Pinecone({ apiKey });
  const existing = (await pc.listIndexes()).indexes?.map((i) => i.name) ?? [];
  if (!existing.includes(INDEX_NAME)) {
    console.log(`Creating index ${INDEX_NAME}…`);
    await pc.createIndex({
      name: INDEX_NAME,
      dimension: 1024,
      metric: "cosine",
      spec: { serverless: { cloud: "aws", region: "us-east-1" } },
      waitUntilReady: true,
      suppressConflicts: true,
    });
  }

  // Pinecone metadata values must be strings/numbers/booleans/lists – drop undefined fields.
  const records = chunks.map((c) => ({
    id: createHash("sha1").update(c.text).digest("hex"),
    values: c.embedding,
    metadata: { text: c.text, source: c.metadata.source, ...(c.metadata.repo ? { repo: c.metadata.repo } : {}), ...(c.metadata.filePath ? { filePath: c.metadata.filePath } : {}), ...(c.metadata.section ? { section: c.metadata.section } : {}) },
  }));
  await upsertChunks(records);
  console.log(`Upserted ${records.length} records into ${INDEX_NAME}.`);
}

main().catch((e) => {
  console.error("seed-pinecone failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

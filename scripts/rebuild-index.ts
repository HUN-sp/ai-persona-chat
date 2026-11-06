/**
 * Rebuild data/index.json from data/resume.txt + the owner's public GitHub repos.
 *
 *   npm run rebuild-index
 *
 * Needs (in .env.local): COHERE_API_KEY (paid embeddings), GITHUB_TOKEN (optional, avoids rate limits).
 * Review the diff of data/index.json before committing – then optionally re-seed Pinecone
 * with `npm run seed-pinecone`.
 */
import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: join(process.cwd(), ".env.local") });

async function main() {
  if (!(process.env.COHERE_API_KEY ?? process.env.CO_API_KEY)) {
    console.error("COHERE_API_KEY is not set (put it in .env.local). Nothing was changed.");
    process.exit(1);
  }
  const { buildFreshIndex } = await import("../lib/index-builder");
  const index = await buildFreshIndex();
  const out = join(process.cwd(), "data", "index.json");
  writeFileSync(out, JSON.stringify(index));
  console.log(`Wrote ${index.length} chunks to ${out}`);
}

main().catch((e) => {
  console.error("rebuild-index failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

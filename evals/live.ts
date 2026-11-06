/**
 * LIVE evals – real Cohere/Pinecone retrieval + real Groq. Costs a few cents; run on demand:
 *
 *   npm run evals:live            (needs GROQ_API_KEY and COHERE_API_KEY in .env.local)
 *
 * Scores the same ground-truth dataset as the offline harness, plus the questions the
 * offline lexical proxy can't judge (`lexicalSkip`). Exit code 1 if any check fails.
 * NOT run in CI (no secrets there). Never makes calendar or Vapi calls.
 */
import { config } from "dotenv";
import { join } from "node:path";
import dataset from "./dataset.json";

config({ path: join(process.cwd(), ".env.local") });

type QA = {
  id: string; category: string; question: string; intent: string;
  retrievalMustContain?: string[]; answerMustContainAny?: string[]; answerMustNotContain?: string[];
  answerMustDeflect?: boolean; lexicalSkip?: string;
};
const has = (h: string, n: string) => h.toLowerCase().includes(n.toLowerCase());

async function main() {
  if (!process.env.GROQ_API_KEY || !(process.env.COHERE_API_KEY ?? process.env.CO_API_KEY)) {
    console.error("evals:live needs GROQ_API_KEY and COHERE_API_KEY (put them in .env.local). Nothing was called.");
    process.exit(1);
  }
  const { retrieve } = await import("../lib/retriever");
  const { generateRagAnswer } = await import("../lib/chat");
  const { classifyIntent } = await import("../lib/router");
  const { OWNER_EMAIL } = await import("../lib/config");

  const rows: { id: string; category: string; pass: boolean; why: string }[] = [];
  for (const q of dataset.qa as QA[]) {
    if (classifyIntent(q.question, "idle") !== "chat") continue; // routed without the LLM: covered offline
    const failures: string[] = [];
    const ctx = await retrieve(q.question, 5);
    for (const f of q.retrievalMustContain ?? []) if (!has(ctx, f)) failures.push(`retrieval missing "${f}"`);

    const msgs = [{ role: "user" as const, content: q.question }];
    const answer = await generateRagAnswer(msgs, q.question);
    if (q.answerMustContainAny && !q.answerMustContainAny.some((f) => has(answer, f))) failures.push(`answer lacks any of ${JSON.stringify(q.answerMustContainAny)}`);
    for (const bad of q.answerMustNotContain ?? []) if (has(answer, bad)) failures.push(`answer contains "${bad}"`);
    if (q.answerMustDeflect && !(has(answer, OWNER_EMAIL) || /don't have that|not in my|can't share|outside my/i.test(answer))) failures.push("did not deflect");

    rows.push({ id: q.id, category: q.category, pass: failures.length === 0, why: failures.join("; ") });
    console.log(`${failures.length ? "FAIL" : "ok  "} ${q.id} [${q.category}] ${failures.join("; ")}`);
  }

  const cats = [...new Set(rows.map((r) => r.category))];
  console.log("\n| category | passed |\n|---|---|");
  for (const c of cats) {
    const rs = rows.filter((r) => r.category === c);
    console.log(`| ${c} | ${rs.filter((r) => r.pass).length}/${rs.length} |`);
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("evals:live crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Deterministic stand-in for the Cohere + Pinecone retriever, used by the OFFLINE evals.
 * BM25-flavoured lexical ranking over the exact chunk texts shipped in data/index.json.
 * It is NOT a measure of Cohere retrieval quality – it checks that the facts are present
 * in the shipped index and reachable, and gives the pipeline realistic context to carry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STOP = new Set("a an and are as at be by do does for from how i in is it of on or that the this to was what when where which who why with you your my me tell about did have has had can could would should".split(" "));
const tokenize = (t: string) => (t.toLowerCase().match(/[a-z0-9+#.%/-]+/g) ?? []).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length > 1 && !STOP.has(w));

let corpus: { text: string; tf: Map<string, number>; len: number }[] | null = null;
let df = new Map<string, number>();

function load() {
  if (corpus) return corpus;
  const raw: { text: string }[] = JSON.parse(readFileSync(join(process.cwd(), "data", "index.json"), "utf-8"));
  corpus = raw.map(({ text }) => {
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { text, tf, len: toks.length };
  });
  df = new Map();
  for (const d of corpus) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return corpus;
}

/** Top-k chunk texts for a query (empty if nothing overlaps – like the score threshold). */
export function lexicalTopK(query: string, k = 5): string[] {
  const docs = load();
  const N = docs.length;
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / N;
  const q = [...new Set(tokenize(query))];
  const scored = docs
    .map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avgLen))));
      }
      return { text: d.text, s };
    })
    .filter((x) => x.s > 1.5) // analogous to the cosine threshold: weak lexical overlap → no context
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  return scored.map((x) => x.text);
}

export const lexicalRetrieve = async (query: string, k = 5) => lexicalTopK(query, k).join("\n\n---\n\n");

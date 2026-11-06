/**
 * Regenerate tests/fixtures/system-prompt.golden.txt from the active persona.
 * Run ONLY after an intentional change to persona/template.ts or persona.json,
 * then review the diff – it is exactly what the model will be told.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "../persona";

const out = join(process.cwd(), "tests", "fixtures", "system-prompt.golden.txt");
writeFileSync(out, SYSTEM_PROMPT);
console.log(`Wrote ${SYSTEM_PROMPT.length} chars to ${out}`);

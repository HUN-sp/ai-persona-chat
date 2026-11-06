/**
 * Active persona (server side). A new persona = a new folder `persona/<id>/` with
 * persona.json + ui.json, registered below and selected with PERSONA_ID.
 * See docs/PERSONA.md.
 */
import vinay from "./vinay/persona.json";
import type { PersonaConfig } from "./types";
import { buildSystemPrompt } from "./render";

const REGISTRY: Record<string, PersonaConfig> = {
  vinay: vinay as PersonaConfig,
};

const id = process.env.PERSONA_ID ?? "vinay";
const found = REGISTRY[id];
if (!found) throw new Error(`Unknown PERSONA_ID "${id}". Known: ${Object.keys(REGISTRY).join(", ")}`);

export const persona: PersonaConfig = found;
export const SYSTEM_PROMPT = buildSystemPrompt(persona);
export { buildSystemPrompt, renderTemplate } from "./render";

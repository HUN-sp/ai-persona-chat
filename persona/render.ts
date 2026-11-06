import { PROMPT_TEMPLATE } from "./template";
import type { PersonaConfig } from "./types";

/** Replace `{{a.b.c}}` placeholders from `vars`. Throws on a missing value – a typo must not ship silently. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), vars);
    if (typeof value !== "string") throw new Error(`persona template: no string value for {{${path}}}`);
    return value;
  });
}

export function buildSystemPrompt(p: PersonaConfig): string {
  const assignmentSection = p.assignmentContext.enabled ? `## CONTEXT ASSIGNMENT\n${p.assignmentContext.text}\n\n` : "";
  return renderTemplate(PROMPT_TEMPLATE, { ...p, assignmentSection });
}

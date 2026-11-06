import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { persona, SYSTEM_PROMPT, renderTemplate, buildSystemPrompt } from "@/persona";
import { personaUi } from "@/persona/ui";
import { OWNER_EMAIL, OWNER_PHONE, OWNER_GITHUB, OWNER_NAME } from "@/lib/config";

describe("data-driven persona (Phase 4b)", () => {
  it("renders a system prompt byte-identical to the one that was hard-coded before the refactor", () => {
    const golden = readFileSync(join(__dirname, "fixtures", "system-prompt.golden.txt"), "utf-8");
    expect(SYSTEM_PROMPT).toBe(golden);
  });

  it("every fact the prompt cites is evidenced in the resume (no drift between persona.json and resume.txt)", () => {
    const resume = readFileSync(join(process.cwd(), persona.resumePath), "utf-8").toLowerCase();
    const missing = persona.evidence.filter((e) => !resume.includes(e.toLowerCase()));
    expect(missing).toEqual([]);
  });

  it("every number cited in the prompt's fact lines is covered by an evidence entry", () => {
    const evidence = persona.evidence.join(" ").toLowerCase();
    const factText = Object.values(persona.facts).join(" ");
    const numbers = factText.match(/\d[\d.,%/]*\d%?|\d%?/g) ?? [];
    const uncovered = numbers
      .map((n) => n.replace(/[.,/]+$/, ""))
      .filter((n) => !evidence.includes(n.toLowerCase()) && !persona.evidence.some((e) => e.toLowerCase().includes(n.toLowerCase())));
    expect(uncovered).toEqual([]);
  });

  it("contact constants come from the persona and still match the resume header", () => {
    const resume = readFileSync(join(process.cwd(), persona.resumePath), "utf-8");
    expect(OWNER_NAME).toBe(persona.owner.name);
    expect(resume).toContain(OWNER_EMAIL);
    expect(resume).toContain(OWNER_PHONE);
    expect(resume).toContain(OWNER_GITHUB);
  });

  it("the template renderer is strict: a missing placeholder throws instead of shipping '{{x}}'", () => {
    expect(() => renderTemplate("hi {{owner.nope}}", persona as unknown as Record<string, unknown>)).toThrow(/owner\.nope/);
    expect(renderTemplate("hi {{ owner.shortName }}", persona as unknown as Record<string, unknown>)).toBe("hi Vinay");
  });

  it("a different persona is a data change: swapping the JSON changes the prompt, nothing else needed", () => {
    const other = {
      ...persona,
      owner: { name: "Ada Lovelace", shortName: "Ada", possessive: "her" },
      contact: { ...persona.contact, email: "ada@example.org", phone: "+44-0", github: "https://github.com/ada" },
      assignmentContext: { enabled: false, text: "" },
    };
    const p = buildSystemPrompt(other);
    expect(p).toContain("AI representative of Ada Lovelace");
    expect(p).toContain("ada@example.org");
    expect(p).not.toContain("Vinay");
    expect(p).not.toContain("## CONTEXT ASSIGNMENT");
    expect(p).not.toMatch(/\{\{/);
  });

  it("the browser-facing persona carries no private contact data", () => {
    const json = JSON.stringify(personaUi);
    expect(json).not.toContain(persona.contact.phone);
    expect(json).not.toContain(persona.contact.calendarAttendeeEmail);
    expect(json).not.toContain(persona.contact.email);
  });

  it("the rendered prompt has no unreplaced placeholders", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\{\{|\}\}/);
  });
});

describe("no persona-specific strings outside persona/ (Phase 4b)", () => {
  it("source files do not hard-code the owner's contact data or name in user-facing code", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    for (const d of ["app", "lib"]) walk(join(process.cwd(), d));
    const secrets = [persona.contact.phone, persona.contact.email, persona.contact.calendarAttendeeEmail, persona.contact.githubUsername];
    const offenders = files.flatMap((f) => {
      const src = readFileSync(f, "utf-8");
      return secrets.filter((s) => src.includes(s)).map((s) => `${f.replace(process.cwd() + "/", "")}: ${s}`);
    });
    expect(offenders).toEqual([]);
  });
});

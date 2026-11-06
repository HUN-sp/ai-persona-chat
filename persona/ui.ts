/** Active persona (browser-safe subset: no phone, no calendar attendee). */
import vinayUi from "./vinay/ui.json";
import type { PersonaUi } from "./types";

const REGISTRY: Record<string, PersonaUi> = { vinay: vinayUi as PersonaUi };

export const personaUi: PersonaUi = REGISTRY[process.env.NEXT_PUBLIC_PERSONA_ID ?? "vinay"] ?? REGISTRY.vinay;

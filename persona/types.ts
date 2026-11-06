export interface PersonaConfig {
  id: string;
  owner: { name: string; shortName: string; possessive: string };
  org: { name: string };
  contact: { email: string; phone: string; github: string; githubUsername: string; calendarAttendeeEmail: string };
  facts: {
    education: string;
    skills: string;
    projects: string;
    openSource: string;
    fitCitations: string;
    fitTagline: string;
  };
  /** Strings that MUST appear in the resume file – a test fails if a fact above drifts away from it. */
  evidence: string[];
  assignmentContext: { enabled: boolean; text: string };
  resumePath: string;
  pineconeIndex: string;
  routing: { keywords: string[]; notBookingContexts: string[] };
}

/** Everything the browser may see (no phone number, no calendar attendee). */
export interface PersonaUi {
  initials: string;
  tagline: string;
  pageTitle: string;
  pageDescription: string;
  displayName: string;
  shortName: string;
  greeting: string;
  bookMessage: string;
  placeholder: string;
  suggestedQuestions: string[];
  vapi: { publicKey: string; assistantId: string };
}

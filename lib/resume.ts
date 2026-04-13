import fs from "fs";
import path from "path";

export interface ResumeChunk {
  section: string;
  content: string;
  source: "resume";
}

const RESUME_PATH = path.join(process.cwd(), "data", "resume.txt");

export function fetchResumeChunks(): ResumeChunk[] {
  if (!fs.existsSync(RESUME_PATH)) {
    console.warn("resume.txt not found at:", RESUME_PATH);
    return [];
  }

  const text = fs.readFileSync(RESUME_PATH, "utf-8");

  // Split by ALL-CAPS section headings (lines that are fully uppercase)
  const lines = text.split("\n");
  const chunks: ResumeChunk[] = [];
  let currentSection = "General";
  let currentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect section heading: all caps, at least 3 chars, no lowercase
    if (trimmed.length >= 3 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      if (currentLines.length > 0) {
        const content = currentLines.join("\n").trim();
        if (content.length > 20) {
          chunks.push({ section: currentSection, content, source: "resume" });
        }
      }
      currentSection = trimmed;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Push last section
  if (currentLines.length > 0) {
    const content = currentLines.join("\n").trim();
    if (content.length > 20) {
      chunks.push({ section: currentSection, content, source: "resume" });
    }
  }

  return chunks;
}

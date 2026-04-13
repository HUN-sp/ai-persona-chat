import fs from "fs";
import path from "path";

export interface ResumeChunk {
  section: string;
  content: string;
  source: "resume";
}

const RESUME_PATH = path.join(process.cwd(), "data", "resume.txt");

// Split the PROJECTS section into one chunk per project
function splitProjectsSection(content: string): ResumeChunk[] {
  const chunks: ResumeChunk[] = [];
  const blocks = content.split(/\n\n+/);
  let currentName = "Project";
  let currentLines: string[] = [];

  for (const block of blocks) {
    const firstLine = block.trim().split("\n")[0];
    // Project title: capitalized words, no colon (not a field label like "Tech: ...")
    const isTitle =
      firstLine.length > 2 &&
      /^[A-Z][a-zA-Z0-9 ]+$/.test(firstLine) &&
      !firstLine.includes(":");

    if (isTitle) {
      if (currentLines.length > 0) {
        const text = currentLines.join("\n\n").trim();
        if (text.length > 20) {
          chunks.push({ section: `PROJECT: ${currentName}`, content: text, source: "resume" });
        }
      }
      currentName = firstLine;
      currentLines = [block];
    } else {
      currentLines.push(block);
    }
  }

  if (currentLines.length > 0) {
    const text = currentLines.join("\n\n").trim();
    if (text.length > 20) {
      chunks.push({ section: `PROJECT: ${currentName}`, content: text, source: "resume" });
    }
  }

  return chunks;
}

export function fetchResumeChunks(): ResumeChunk[] {
  if (!fs.existsSync(RESUME_PATH)) {
    console.warn("resume.txt not found at:", RESUME_PATH);
    return [];
  }

  const text = fs.readFileSync(RESUME_PATH, "utf-8");

  // Split by ALL-CAPS section headings
  const lines = text.split("\n");
  const chunks: ResumeChunk[] = [];
  let currentSection = "General";
  let currentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Section heading: all caps, at least 3 chars, contains a letter
    if (trimmed.length >= 3 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      if (currentLines.length > 0) {
        const content = currentLines.join("\n").trim();
        if (content.length > 20) {
          if (currentSection === "PROJECTS") {
            // Split PROJECTS into individual project chunks
            chunks.push(...splitProjectsSection(content));
          } else {
            chunks.push({ section: currentSection, content, source: "resume" });
          }
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
      if (currentSection === "PROJECTS") {
        chunks.push(...splitProjectsSection(content));
      } else {
        chunks.push({ section: currentSection, content, source: "resume" });
      }
    }
  }

  return chunks;
}

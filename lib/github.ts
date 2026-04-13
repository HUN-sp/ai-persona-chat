const GITHUB_USERNAME = "HUN-sp";
const BASE_URL = "https://api.github.com";

const SOURCE_EXTENSIONS = new Set([
  ".cpp", ".c", ".h", ".hpp",
  ".java", ".py", ".ts", ".js",
  ".go", ".rs", ".md", ".txt",
]);

function isSourceFile(path: string): boolean {
  const ext = "." + path.split(".").pop()?.toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
}

export interface CodeChunk {
  repo: string;
  filePath: string;
  content: string;
  source: "github";
}

async function fetchRepos(): Promise<string[]> {
  const res = await fetch(
    `${BASE_URL}/users/${GITHUB_USERNAME}/repos?sort=updated&per_page=10`,
    { headers: getHeaders() }
  );
  const repos = await res.json();
  if (!Array.isArray(repos)) return [];
  return repos.map((r: { name: string }) => r.name).slice(0, 10);
}

async function fetchFileTree(repo: string): Promise<string[]> {
  const res = await fetch(
    `${BASE_URL}/repos/${GITHUB_USERNAME}/${repo}/git/trees/HEAD?recursive=1`,
    { headers: getHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.tree) return [];
  return data.tree
    .filter((f: { type: string; path: string }) => f.type === "blob" && isSourceFile(f.path))
    .map((f: { path: string }) => f.path)
    .slice(0, 5); // max 5 files per repo to stay within rate limits
}

async function fetchFileContent(repo: string, path: string): Promise<string> {
  const res = await fetch(
    `${BASE_URL}/repos/${GITHUB_USERNAME}/${repo}/contents/${path}`,
    { headers: getHeaders() }
  );
  if (!res.ok) return "";
  const data = await res.json();
  if (!data.content) return "";
  return Buffer.from(data.content, "base64").toString("utf-8");
}

export async function fetchGitHubChunks(): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];
  const repos = await fetchRepos();

  for (const repo of repos) {
    const files = await fetchFileTree(repo);
    for (const filePath of files) {
      const content = await fetchFileContent(repo, filePath);
      if (!content.trim()) continue;
      // chunk large files into 80-line pieces
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 80) {
        const chunk = lines.slice(i, i + 80).join("\n").trim();
        if (chunk.length > 50) {
          chunks.push({ repo, filePath, content: chunk, source: "github" });
        }
      }
    }
  }

  return chunks;
}

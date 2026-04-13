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

interface RepoMeta {
  name: string;
  description: string | null;
  language: string | null;
  url: string;
  fork: boolean;
}

async function fetchAllRepos(): Promise<RepoMeta[]> {
  const res = await fetch(
    `${BASE_URL}/users/${GITHUB_USERNAME}/repos?sort=updated&per_page=100`,
    { headers: getHeaders() }
  );
  const repos = await res.json();
  if (!Array.isArray(repos)) return [];
  return repos.map((r: { name: string; description: string | null; language: string | null; html_url: string; fork: boolean }) => ({
    name: r.name,
    description: r.description,
    language: r.language,
    url: r.html_url,
    fork: r.fork,
  }));
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
    .slice(0, 5);
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
  const repos = await fetchAllRepos();

  // ── Special chunk: full repo list for "list all repos" questions ──
  const repoList = repos
    .map((r) => `- ${r.name} (${r.language ?? "unknown"})${r.fork ? " [fork]" : ""}${r.description ? ": " + r.description : ""} — ${r.url}`)
    .join("\n");

  chunks.push({
    repo: "__meta__",
    filePath: "repo-list",
    content: `[All public GitHub repositories for HUN-sp / Vinay Kumar Chopra]\n\n${repoList}`,
    source: "github",
  });

  // ── Per-repo metadata chunk ──
  for (const repo of repos) {
    chunks.push({
      repo: repo.name,
      filePath: "__meta__",
      content: `[repo: ${repo.name}] Language: ${repo.language ?? "unknown"}${repo.fork ? " (fork)" : ""}. ${repo.description ?? ""}. URL: ${repo.url}`,
      source: "github",
    });
  }

  // ── Source file chunks (top 5 files per repo, first 15 repos) ──
  for (const repo of repos.slice(0, 15)) {
    const files = await fetchFileTree(repo.name);
    for (const filePath of files) {
      const content = await fetchFileContent(repo.name, filePath);
      if (!content.trim()) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 80) {
        const chunk = lines.slice(i, i + 80).join("\n").trim();
        if (chunk.length > 50) {
          chunks.push({ repo: repo.name, filePath, content: chunk, source: "github" });
        }
      }
    }
  }

  return chunks;
}

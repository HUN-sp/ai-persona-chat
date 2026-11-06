import { describe, it, expect, afterEach, vi } from "vitest";

const repos = [
  { name: "own-app", description: "mine", language: "TypeScript", html_url: "u1", fork: false },
  { name: "prime-environments", description: "third party", language: "Python", html_url: "u2", fork: true },
  { name: "grass", description: "contrib", language: "C", html_url: "u3", fork: true },
];

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("github chunk fetcher (offline, fetch mocked)", () => {
  it("sends no Authorization header when no token is configured", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("YOUR_TOKEN", "");
    const f = mockFetch((url) => (url.includes("/users/") ? Response.json(repos) : new Response("", { status: 404 })));
    const { fetchGitHubChunks } = await import("@/lib/github");
    await fetchGitHubChunks();
    const headers = f.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws on rate-limit / bad token instead of silently indexing nothing", async () => {
    mockFetch(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const { fetchGitHubChunks } = await import("@/lib/github");
    await expect(fetchGitHubChunks()).rejects.toThrow(/401/);
  });

  it("skips source files of third-party forks but keeps allow-listed forks and the repo list", async () => {
    const fetched: string[] = [];
    mockFetch((url) => {
      fetched.push(url);
      if (url.includes("/users/")) return Response.json(repos);
      if (url.includes("/git/trees/")) return Response.json({ tree: [] });
      return new Response("", { status: 404 });
    });
    const { fetchGitHubChunks } = await import("@/lib/github");
    const chunks = await fetchGitHubChunks();
    expect(fetched.some((u) => u.includes("/repos/HUN-sp/own-app/git/trees"))).toBe(true);
    expect(fetched.some((u) => u.includes("/repos/HUN-sp/grass/git/trees"))).toBe(true);
    expect(fetched.some((u) => u.includes("/repos/HUN-sp/prime-environments/git/trees"))).toBe(false);
    // the repo list/meta chunks still mention every repo
    expect(chunks.find((c) => c.filePath === "repo-list")!.content).toContain("prime-environments");
  });
});

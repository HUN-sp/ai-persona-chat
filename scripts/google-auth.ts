/**
 * One-off helper to mint a GOOGLE_REFRESH_TOKEN for the calendar owner.
 *
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run google-auth
 *
 * (or put the two values in .env.local). It prints an authorisation URL; sign in as
 * the calendar owner, approve, and paste the `code=` value from the (failed-to-load)
 * http://localhost redirect back here. The refresh token is printed to YOUR terminal
 * only – copy it into Vercel env vars. Nothing is written to disk.
 *
 * The OAuth client must list http://localhost as an authorised redirect URI
 * (that is what lib/calendar.ts uses).
 */
import { config } from "dotenv";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";

config({ path: join(process.cwd(), ".env.local") });

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events", // events.insert (+ Meet link)
  "https://www.googleapis.com/auth/calendar.freebusy", // freebusy.query
];

async function main() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
    process.exit(1);
  }
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "http://localhost");
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  console.log("\n1. Open this URL and approve access:\n\n" + url + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("2. Paste the `code` parameter from the redirect URL: ")).trim();
  rl.close();
  const { tokens } = await client.getToken(decodeURIComponent(code));
  if (!tokens.refresh_token) {
    console.error("No refresh token returned. Revoke the app at myaccount.google.com/permissions and try again.");
    process.exit(1);
  }
  console.log("\nGOOGLE_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
}

main().catch((e) => {
  console.error("google-auth failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

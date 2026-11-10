import { createSession } from "./session";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

// Session cookies for the dashboard.
// Rotated quarterly; see docs/runbook.md.

export const session = createSession({
  secret: requireEnv("AUTH_SECRET"),
  maxAge: 60 * 60 * 24,
});

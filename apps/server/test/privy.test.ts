import { expect, test } from "bun:test";
import { redact } from "../src/privy.ts";

test("an upstream error body cannot carry a credential out of the process", () => {
  // Privy answers a bad refresh with a body that names it. That error reaches /api/alive,
  // which is served to anyone, so nothing token-shaped may survive into it.
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const safe = redact(`invalid refresh_token: ${jwt}`);
  for (const segment of jwt.split(".")) expect(safe).not.toContain(segment);
  expect(safe).toBe("invalid refresh_token: ….….…");
  // Short words are what makes the message readable at all, so they stay.
  expect(redact("privy: session expired")).toBe("privy: session expired");
});

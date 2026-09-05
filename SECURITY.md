# Security

fomopulse is read-only. It holds no private keys, signs nothing, and its only inputs are
public RPC data, DexScreener quotes and the configuration files in this repository. The
endpoints it reads, `RPC_WS_URL` / `RPC_HTTP_URL`, stay in `.env`, which is ignored by git.
`FOMO_ACCESS_TOKEN` and the pair that renews it, `FOMO_PRIVY_PAT` and
`FOMO_REFRESH_TOKEN`, are a read-only session from a logged-in browser and live in the
same ignored file — or, on Cloudflare, in the Worker's secrets. The session is the
operator's own: it reads what that account already sees, on the schedule a person reading
the leaderboard would keep, and it is theirs to run within fomo.family's terms. Nothing
here signs in on anyone's behalf, takes a session that is not the operator's, or writes to
fomo at all.

One thing to know about renewal: Privy trades the pair for a fresh one only while the
token in hand is still valid, and it lives about an hour. The Worker renews well inside
that hour and so keeps going indefinitely, but a copy of the same pair sitting in a local
`.env` goes stale the moment that hour passes, and nothing revives it — a deployment that
has been down for longer comes back with a session it cannot renew. The way out is the way
in: take a fresh one from a signed-in browser and set the secrets again. Measured
2026-09-05: a pair five hours old was refused with `401 Invalid auth token` on every route,
while the deployed one, renewing itself hourly, never lapsed.

Another thing to know: once the session renews itself, the renewed one is kept in
the database, under `fomo:session` in the `meta` table. `*.db` is ignored by git for that
reason, and a database copied off a server — a backup, a volume snapshot, a file handed to
someone to reproduce a bug — carries a live fomo session with it. Delete the row, or
revoke the session by logging out of fomo.family, before passing one on.

If you find a way to make the service leak that endpoint, serve content it should not, or
misprice a fill in a way that could mislead readers, please report it privately through
GitHub's security advisories for this repository rather than a public issue. Include the
transaction hash or request that shows the problem; a receipt fixture is the fastest path to
a fix.

# Repository Review (March 29, 2026)

## Scope Reviewed
- Backend bootstrapping, schema, middleware, auth, matching, admin, payments, waitlist, and static route registration.
- Key files: `server.js`, `routes/*.js`, `lib/config.js`, `README.md`.

## High-priority findings

1. **`/api/waiting-entry` cannot reliably persist entries (likely runtime failure).**
   - `entries.match_id` is defined as an `INTEGER` foreign key referencing `matches(id)`.
   - Route `routes/waiting-entry.js` writes a string pseudo-id (`"<userId>-waiting"`) into `match_id` and does not create a matching row in `matches`.
   - With `PRAGMA foreign_keys = ON`, this is expected to fail with a constraint/datatype error.
   - **Impact:** users waiting for a partner cannot save a Day 1 entry as intended.

2. **In-memory password reset tokens are lost on restart and have no cleanup loop.**
   - `routes/auth.js` stores reset tokens in an in-memory `Map`.
   - Restarting the process invalidates all issued tokens; stale tokens remain until used.
   - **Impact:** inconsistent UX and operational fragility for password recovery.

3. **Admin authentication is a single shared static secret passed via header/query.**
   - `requireAdmin` accepts `x-admin-password`, `x-admin-key`, or `?key=` and compares to `ADMIN_PASSWORD`.
   - No user-level auditability, rotation support, or scoped permissions.
   - Query-string auth can leak in logs/history.
   - **Impact:** elevated security risk for admin endpoints and export functionality.

## Medium-priority findings

4. **Duplicate/overlapping route registration for `/admin`, `/privacy`, and `/terms`.**
   - Registered in both `server.js` and route modules.
   - **Impact:** maintainability risk and route ambiguity.

5. **README drift from actual runtime defaults.**
   - README states local app default at port `3000`, server uses `PORT || 8080`.
   - **Impact:** onboarding confusion.

6. **Session secret fallback persisted on local filesystem (`.session-secret`).**
   - Useful for continuity, but operationally fragile in ephemeral/containerized setups if volume not stable.
   - **Impact:** surprise global logout on redeploy if file is lost.

## Lower-priority observations

7. **No automated test/lint scripts configured in `package.json`.**
   - **Impact:** regressions are easier to introduce and harder to catch.

8. **Fallback 404 serves `public/app.html` for any unknown path.**
   - Good for SPA behavior, but for API typos this may return HTML instead of JSON unless route order catches it first.

## Recommended next actions

1. Redesign waiting entry persistence:
   - Add dedicated `waiting_entries` table keyed by `user_id` and day,
   - or create a proper pre-match journal model not coupled to `matches(id)` FK.
2. Move password reset to durable, expiring storage (`password_reset_tokens` table) and add one-time-use semantics.
3. Replace static admin secret with authenticated admin users (session/JWT + RBAC), and remove query param auth.
4. Remove duplicate route definitions and centralize static/admin route ownership.
5. Add baseline quality gates (`npm run lint`, `npm test`) and at least smoke tests for core routes.
6. Update README runtime defaults and environment variable documentation.


# IDOR sweep — 22 September 2026

Systematic review of every route that accepts a user-controlled identifier, checking that access is properly scoped before any read, write, or delete. Closes launch ladder §3's "complete the ownership-check audit across all user-controlled IDs" item.

Auditor: Claude. Confirmed against `main` at commit `7f92b84`. Reproduce with the grep in the appendix.

## Scope

Every route that could enable an Insecure Direct Object Reference — one authenticated user acting on another user's records by supplying that other user's id.

- 16 routes with a path-parameter id (`:id`, `:slug`, `:kind`, `:userId`) across `routes/rooms.js`, `routes/shelf.js`, `routes/silent.js`
- 7 admin routes with body-carried ids (`user_id`, `match_id`, `report_id`) in `routes/admin.js`
- All `/api/` routes in `server.js` — verified to be session-scoped and to accept no body-carried target ids

## Findings

**No IDORs found.** Every route reviewed either:

- **Session-scoped** — writes/reads limited to `req.session.userId`, never accepts a target user id from the request
- **Ownership-verified** — checks the row's `user_id` matches `req.session.userId` before acting, with SQL and application-level guards where possible
- **Public-by-design** — anonymous surface (Rooms, silent-line feed) where the model is any-user-reads-any-row, and the model is called out in the file's header comment
- **Admin-only** — behind `requireAdmin` (session-backed after #45, legacy header grace path)
- **404-shielded** — returns 404 rather than 403 for out-of-scope viewers so existence itself never leaks (shelf partner reads)

## Route-by-route table

### Rooms (public anonymous walls, no membership concept by design)

| Route | Access model | Verdict |
|---|---|---|
| `GET /api/rooms/:slug/cards` | reads active room by slug; anyone signed in reads any active room | ✅ by design |
| `POST /api/rooms/:slug/cards` | `author_id = req.session.userId`; rate-limited 1/hour; frozen-room 423 | ✅ by design |
| `GET /api/cards/:id/comments` | any card readable by any signed-in user | ✅ by design |
| `POST /api/cards/:id/comments` | `author_id = req.session.userId`; rate-limited 5/10min | ✅ by design |
| `POST /api/cards/:id/react` | reactions keyed on `(card_id, user_id, kind)`; no cross-user interference | ✅ by design |
| `POST /api/comments/:id/report` | `INSERT OR IGNORE (comment_id, reporter_id)` prevents duplicate; auto-hide after N distinct reports | ✅ by design |
| `POST /admin/rooms/comments/:id/restore` | requireAdmin | ✅ admin-only |
| `POST /admin/rooms/comments/:id/remove` | requireAdmin | ✅ admin-only |
| `POST /admin/rooms/:slug/freeze` | requireAdmin | ✅ admin-only |

### Shelf

| Route | Access model | Verdict |
|---|---|---|
| `PUT /api/shelf/:kind` | writes to `req.session.userId`; `:kind` validated against `KINDS_SET` | ✅ owner-scoped |
| `DELETE /api/shelf/:kind` | same shape | ✅ owner-scoped |
| `GET /api/shelf/user/:userId` | 404 unless `partnerId === targetId`; unlock-day-respecting; memory always excluded | ✅ correctly scoped (defense-in-depth: 404 shields existence) |

### Silent Room

| Route | Access model | Verdict |
|---|---|---|
| `POST /api/silent/:id/resonate` | resonance is public-by-design like Rooms; `(line_id, user_id)` keyed | ✅ by design |
| `DELETE /api/silent/:id` | code guard `line.user_id !== req.session.userId → 404` AND SQL predicate `WHERE id = ? AND user_id = ?` | ✅ owner-scoped, defense-in-depth |
| `POST /admin/silent/approve/:id` | requireAdmin | ✅ admin-only |
| `POST /admin/silent/reject/:id` | requireAdmin | ✅ admin-only |

### Admin body-carried ids (`routes/admin.js`)

All seven are under `requireAdmin`. Admin acts on any user/match/report by design; there is no "one admin can only see their own users" scoping to violate.

| Route | Body id(s) | Auth |
|---|---|---|
| `POST /admin/manual-match` | `user1_id`, `user2_id` | ✅ requireAdmin |
| `POST /admin/reveal` | `user_id`, `match_id` | ✅ requireAdmin |
| `POST /admin/delete-user` | `user_id` | ✅ requireAdmin |
| `POST /admin/reports/status` | `report_id` | ✅ requireAdmin |
| `POST /admin/reports/note` | `report_id` | ✅ requireAdmin |

### `server.js` `/api/` routes

Confirmed:

- Every `/api/` route in server.js uses `apiLimiter, requireAuth`
- Every mutation reads/writes `req.session.userId` — no body-carried target-user parameter
- Grep for `req.body.*_id` / `req.body.*Id` across `server.js`, `routes/app.js`, `routes/tonights-question.js`, `routes/waiting-entry.js`, `routes/shelf.js`, `routes/rooms.js`, `routes/silent.js` returns **zero hits outside `routes/admin.js`**

## Adjacent concerns (not IDOR, worth flagging)

**1. Rooms report threshold** — `AUTO_HIDE_REPORTS = 2` in `routes/rooms.js` means two coordinated users can suppress any comment. This is a moderation-model concern, not access-control. Consider raising the threshold, applying decay, or requiring reports from users with age-of-account before shipping.

**2. Rooms PII in card bodies** — `scanForSafety(body)` runs but the card body is stored regardless (only held on crisis-detection). A user can PII themselves in Rooms even against the app's stated anonymity. Consider blocking PII cards outright the way `/api/shelf/:kind` requires `piiConfirmed`.

**3. Rooms cards + comments are stored plaintext** — by design in the Living Night model (public wall), but note it here for the record: encryption at rest (PR #43) does not cover Rooms because Rooms are not private.

Neither of these blocks the ladder §3 IDOR item; they belong under moderation policy and Rooms design decisions.

## Regression fence

`test/idor.test.js` codifies the "no target-id-in-body outside `routes/admin.js`" invariant so a future PR that introduces one fails smoke rather than sliding past review. The check is a grep over `req\.body\.\w*(_id|Id)\b` across all route files, excluding `routes/admin.js` and its admin-only patterns. Extend it when a new legitimate exception lands.

## Appendix — reproduction

```bash
# every :id-shaped path param
grep -rnoE "app\.(get|post|put|patch|delete)\('([^']+/:[^'/]+)+" server.js routes/*.js

# every body-carried target id (should return only routes/admin.js hits)
grep -rnE "req\.body\.\w*(_id|Id)\b" server.js routes/

# every :id route with what it does with req.params
grep -rnE "req\.params\." routes/
```

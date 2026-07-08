# Ticket Master Server — Requirements & Build Spec

**Method:** You write every line of code, cold, timed. No AI-authored code. This doc = requirements + acceptance criteria only. It tells you *what* to build and *how you'll know it works* — never *how to write it*.

**Stack (locked):** Node + Express + PostgreSQL + Redis.

**Golden rules (non-negotiable):**
1. AI never touches your editor. Paste finished code back for review only.
2. Every component: build blank-file, 35-min timer, no reference open.
3. Every component retested cold ≥2x, spaced 3–7 days apart.
4. Stuck 20 min → hand-write pseudocode, don't ask AI. Timer keeps running.
5. No copy-paste from this doc. Retype everything, including SQL.

---

## Domain Model

Three core tables. You write the DDL — figure out types, constraints, FKs, indexes yourself.

**events**
- id, name, venue, event_date, total_seats, created_at, is_deleted
- Decide: which columns need indexes? (hint: what does the list/search query filter and sort on?)

**seats**
- id, event_id → events, seat_number, status, price, created_at, is_deleted
- status ∈ {available, held, booked}
- Decide: composite index on (event_id, status)? Justify.

**bookings**
- id, seat_id → seats, user_id, status, created_at
- status ∈ {confirmed, cancelled}
- This table is your audit trail — drives the soft-vs-hard-delete decision on seats.

**Write-down before coding (1 line each):**
- Soft vs hard delete on seats — which and why?
- What isolation level for the booking transaction, and why?

---

## Week 1 — CRUD + Real Concurrency

**Client ask:** "Users book seats without double-booking under concurrent requests."

### Day 1 — CRUD, cold, 35 min
Build POST/GET/PUT/DELETE for `/events` and `/seats`.

| Method | Path | Acceptance criteria |
|--------|------|--------------------|
| POST | /events | Validate required fields BEFORE DB write. 201 + created object. Missing field → 422. |
| GET | /events/:id | Found → 200 + object. Not found → 404 (never 200 + null). |
| PUT | /events/:id | Full replace. **Idempotent**: same body twice = same end state. |
| DELETE | /events/:id | Soft delete (is_deleted=true). Return 204 or 200 — pick one, be consistent. |
| GET | /events | Plain list for now (pagination is Week 2). |

Repeat all 5 for `/seats`.

**Cross-cutting acceptance criteria (every endpoint):**
- Error shape identical everywhere: `{ "error": { "code": "...", "message": "..." } }`
- Status codes correct: 400 malformed / 404 not found / 409 conflict (duplicate create) / 422 validation.
- Validation runs before touching DB. try/catch is NOT validation.

### Day 2 — Concurrency, cold, 35 min
Build seat-hold + booking so two concurrent requests for the same seat never both succeed.

- Use **DB-level locking**, not an in-memory semaphore (in-memory fails across multiple app instances).
- Options: pessimistic (`SELECT ... FOR UPDATE`) or optimistic (version column + retry).
- Wire into `POST /bookings`.

**Acceptance test (must pass):**
- Fire 50 concurrent booking requests at ONE seat. Exactly 1 → 201. Other 49 → 409. Zero double-books in DB.
- Write a script that actually hammers it concurrently. "Looks fine" ≠ tested.

### Day 3 — Defend in writing
Written answers (interview reps):
- Isolation level chosen + why.
- Index on seat lookup + why.
- Optimistic vs pessimistic for this access pattern. High contention on hot events → which wins? Argue it.

### Day 4 — Cold rebuild, 35 min, project closed
Rebuild the concurrency mechanism only. Blank file. No peeking at Day 2.

### Day 5 — Outreach + blockers log.

---

## Week 2 — Pagination, Search, Caching, Async

**Client ask:** "Listings must scale, availability lookups are slow, confirmation shouldn't block."

### Day 1 — Pagination, cold
`GET /events` two ways:
- **Offset:** `?page=&limit=`. Simple. In writing: why it breaks under concurrent inserts (skipped/duplicate rows).
- **Cursor/keyset:** `?cursor=&limit=` on an indexed column. If sorting by event_date, cursor must be composite (date + id) — a plain id cursor gives wrong order. Explain why.

**Acceptance criteria:**
- limit has a max cap (e.g. 100). Request for limit=100000 → capped, not OOM.
- Response includes next cursor / next page indicator.
- Empty page → 200 + empty array. Never 404.

### Day 2 — Search (merged into GET /events, not a separate endpoint)
`GET /events?q=&category=&minPrice=&maxPrice=&page=&limit=`

- Filtering IS search — same endpoint. Splitting them = you haven't thought about the query layer.
- Handle: empty q, no results (200 + []), case-insensitivity, partial match.
- **Rate-limit this endpoint specifically** (wire the Week 3 limiter here later; stub now).

**Acceptance criteria:**
- q="" → returns all (no crash).
- No match → 200 + [].
- minPrice > maxPrice → 422, not silent empty.
- Case-insensitive partial match works ("conc" finds "Concert").

### Day 3 — Redis: caching layer, cold
Build LRU cache concept first standalone, then use **Redis** as the cache store for `GET /seats/:eventId/availability`.

**Acceptance criteria:**
- Cache hit path measurably faster than DB path (log both).
- TTL set on cached keys.
- **Invalidation:** on booking write, the affected event's availability cache is invalidated/updated. Stale availability after a booking = fail. This is the part interviews probe.
- Decide + write down: cache-aside vs write-through. Which and why?

### Day 4 — Job queue, async confirmation, cold
Build queue concept standalone (retry + backoff), then use **Redis** as the backing store (list/stream). Wire for async booking confirmation — `POST /bookings` returns immediately, confirmation processed off-request.

**Acceptance criteria:**
- Failed job retries with backoff, capped attempts, then dead-letter (don't retry forever).
- Booking request returns before confirmation work finishes.
- 3-sentence written comparison to Azure Service Bus (use your real migration story).

### Day 5 — Outreach + blockers log.

---

## Week 3 — Traffic Shaping + Notifications

**Client ask:** "High-demand events get hammered — need a waiting room. Users want push confirmations."

### Day 1 — Rate limiter, cold (this one cost you an offer — no shortcuts)
Sliding-window, per-user, backed by **Redis**. Wire as virtual-waiting-room gate in front of booking/search.

**Acceptance criteria:**
- N requests/window enforced per user. N+1th → 429 + Retry-After header.
- Window slides correctly (not a fixed-bucket that resets hard on boundary — know the difference and explain it).
- Works across multiple app instances (state in Redis, not in-process).

### Day 2 — Pub/sub, cold
Redis pub/sub for booking notifications. Booking confirmed → event published → subscriber pushes notification.

**Acceptance criteria:**
- Multiple subscribers each receive the event.
- Publisher doesn't block on subscriber processing.

### Day 3 — Cold rebuild rate limiter, 35 min (second pass = where retention shows).

### Day 4 — Cold rebuild job queue from Week 2 Day 4, 35 min. (Queue/pubsub got skipped for retest in old plans — not this time.)

### Day 5 — Outreach + blockers log.

---

## Week 4 — Partitioning + Demo

**Client ask:** "Expanding to multiple regions — partition the data, walk us through the architecture."

### Day 1 — Consistent hashing, cold, standalone.

### Day 2 — Wire in as event/seat partitioning logic. **Same-day cold rebuild, 30 min** — least-reinforced piece going into a recorded demo needs 2 reps, not 1.

### Day 3 — Recorded unscripted walkthrough.
Before recording, write the 3 hardest questions an interviewer asks about consistent hashing:
- Node join/leave — how much data moves?
- Why virtual nodes?
- Hot-partition handling?
Confirm your unscripted answer actually hits all three.

### Day 4 — Cold rebuild of weakest component across all 4 weeks (excluding consistent hashing, already retested Day 2).

### Day 5 — Final blockers log + decide Week 5 repeat or extend.

---

## Scope Honesty
Single-node throughout. Redis is single instance. No real multi-region deploy. Fine for interview-level concept recall — but if a pipeline company wants deployed distributed infra, this project doesn't show that. Say so honestly; don't imply production-scale.

## Open Item
**DSA maintenance** — not allocated here. Asked 3x, unanswered. Decide: dead, or 2 problems/day cold as a separate track. Silence = it dies.

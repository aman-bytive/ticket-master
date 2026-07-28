# Ticket Master Server — Timeline & Schedule

**Duration:** 6 weeks core (+1 optional), Mon–Fri.
**Start:** Mon 2026-08-11. **Core end:** Fri 2026-09-18. **Optional Week 7 end:** Fri 2026-09-25.
**Method:** cold build, no AI code, 35-min timer per component, blank file, no reference open. Retest cold ≥2×, spaced 3–7 days.

**Daily block:** 1× 35-min cold build + 25 min test/debug + 15 min written defense = ~75 min/day core. Day 5 each week = outreach + blockers log (no build), except Week 5 Day 5 (load test) and Week 6 Day 5 (walkthrough).

**Companion doc:** `REQUIREMENTS.md` — the *what* and the acceptance criteria. This doc is the *when*. Read the matching REQUIREMENTS section before each day, then close it.

**Why 6 weeks not 4:** Elasticsearch, CDC, SSE fan-out, admission control, cancellation, and Stripe are six components that weren't in the original scope. Fitting them into 4 weeks means skipping cold rebuilds, which is the only part of this method that produces retention.

---

## Architecture being built

```
Client ──> CDN ──> API Gateway ──┬──> Auth Service ────> PostgreSQL
                (authn/authz,    │
                 rate limit,     ├──> Search Service ──> Elasticsearch
                 routing,        │
                 correlation id) ├──> Event Service ───> Redis (event cache)
                                 │      · CRUD          └──> PostgreSQL
                                 │      · seat map
                                 │      · SSE stream <── Redis pub/sub
                                 │
                                 └──> Booking Service ──> Redis (holds, queue)
                                        · reserve/confirm/cancel
                                        · admission gate    └──> PostgreSQL
                                        · queue + waitlist
                                        └──> Stripe
                                        └──> Redis pub/sub ──> Event Service SSE

           PostgreSQL ──(outbox poller)──> Elasticsearch
           Admitter (worker) ──> Redis queue
```

**4 HTTP services + 2 workers.** SSE lives on Event Service — same process that serves the reconnect snapshot, so effective-seat-status has one implementation instead of two that drift.

**Hold-state rule:** Booking Service is the only *writer* of hold keys. Event Service reads them. Both through one shared `lib/availability` module.

## Processes and ports

| Process | Port | Owns |
|---|---|---|
| Gateway | 3000 (only public) | authn/authz, rate limit, routing, timeouts, correlation IDs |
| Auth Service | 3001 | register, login, refresh, logout |
| Event Service | 3002 | events/venues/performers CRUD, event cache, seat map, SSE |
| Search Service | 3003 | Elasticsearch queries |
| Booking Service | 3004 | reserve, confirm, cancel, holds, queue, waitlist, Stripe |
| Outbox poller | — | worker, Postgres → ES |
| Admitter | — | worker, drains queue |

Workers have no inbound port. They still need their own crash-restart story and their own graceful-shutdown path — easy to forget until Week 5 Day 2 fails.

## Routing table (built Week 4)

```
POST   /auth/*                    -> Auth      3001   public
GET    /search                    -> Search    3003   public,  rate limited
GET    /events                    -> Event     3002   public
GET    /events/:id                -> Event     3002   public
GET    /events/:id/seatmap        -> Event     3002   public
GET    /events/:id/stream         -> Event     3002   public,  no buffering, no timeout
POST   /events                    -> Event     3002   auth + role
PUT    /events/:id                -> Event     3002   auth + role
DELETE /events/:id                -> Event     3002   auth + role
POST   /events/:id/waitlist       -> Booking   3004   auth
POST   /queue/join                -> Booking   3004   auth,    rate limited
GET    /queue/position            -> Booking   3004   auth
POST   /bookings/reserve          -> Booking   3004   auth,    rate limited, admission required
POST   /bookings/confirm          -> Booking   3004   auth,    rate limited, admission required
POST   /bookings/:id/cancel       -> Booking   3004   auth
POST   /webhooks/stripe           -> Booking   3004   NO auth, NO rate limit
```

Two rows that bite: the Stripe webhook has no JWT so it can't go through gateway auth, and rate-limiting it drops payment confirmations. The SSE route needs response buffering off and the upstream timeout disabled, or it looks broken when the proxy is the problem.

---

## Week 0 — Setup (before Mon 08-11, untimed, not a build day)

| Task | Done when |
|------|-----------|
| Postgres + Redis + Elasticsearch reachable from Node | `SELECT 1`, `PING`, `GET /_cluster/health` all return from app code |
| Migration tool wired (node-pg-migrate / knex / raw + version table) | up and down both run; schema version queryable |
| Repo skeleton: Express app, config loader, error middleware, structured logger, `/health` | `GET /health` → 200; log lines are JSON with a `correlationId` field |
| **Graceful shutdown helper** — SIGTERM drains in-flight requests, closes pools and SSE connections, releases any lease | `kill -TERM` exits clean, no dropped in-flight request |
| **Connection-pool sizes set explicitly per service.** 4 services + 2 workers + load generator vs Postgres `max_connections=100` | pool size written in config, total budget documented in `DECISIONS.md` |
| Stripe test account + local webhook tunnel | test event delivered to localhost and logged |
| Concurrency harness: fires N parallel requests, tallies status codes | prints `{201: x, 409: y}` for any URL + body |
| Redis call counter: wraps the client, counts round trips per request | prints round-trip count per HTTP request |
| Seed script: event with 50 tickets, event with 50,000 tickets | both generate in one command |
| `DECISIONS.md` with the five Week-0 write-downs from REQUIREMENTS | 5 lines written |

None of these are optional:
- Harness → Week 1 Day 2 is unverifiable without it.
- Redis counter → Week 2 Day 2's only real criterion is a round-trip count.
- Seed script → you can't test the 50,000-ticket case by hand.
- Pool sizing → you *will* exhaust `max_connections` during the Week 5 load test, and it looks exactly like a code bug.
- Migrations → six weeks of schema changes without them means manual drift you can't reproduce.

Building any of these under the timer steals build time.

---

## Week 1 — Domain, CRUD, real concurrency (08-11 → 08-15)

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Mon 08-11 | DDL (events, venues, performers, users, tickets, bookings, booking_items) + CRUD for `/events`, `/venues`, `/tickets` | 35 min | missing field → 422 before DB write; not found → 404 never `200+null`; PUT twice = same state; DELETE soft; identical error shape with `correlationId` everywhere |
| 2 | Tue 08-12 | `POST /bookings/confirm` — DB guard, all-or-nothing multi-ticket | 35 min | 50 concurrent at one ticket → 1× 201 / 49× 409; `{A,B}` vs `{B,C}` race leaves no partial booking; opposite-order requests don't deadlock; **guard-removal test proves `UNIQUE(ticket_id)` still holds the line** |
| 3 | Wed 08-13 | Written defense: isolation level, ticket index, optimistic vs pessimistic, why no `held` status, why ownership lives in `booking_items` | 30 min | 5 answers written, nothing open |
| 4 | Thu 08-14 | Cold rebuild: booking-confirm guard only, blank file | 35 min | passes Day 2 harness including guard-removal |
| 5 | Fri 08-15 | Outreach + blockers log. **Decide DSA track: dead or 2/day.** | — | log written, decision recorded |

---

## Week 2 — Holds in Redis + real-time seat map (08-18 → 08-22)

The load-bearing week. If one week gets extra time, it's this one.

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Mon 08-18 | `POST /bookings/reserve` — 10-min TTL hold, atomic claim, all-or-nothing, **per-user cap**, **idempotent retry**; release endpoint | 35 min | two different users → 1× 201 / 1× 409; **same user retry returns existing hold, original `expiresAt`, no TTL refresh**; `{A,B}` with `B` held leaves `A` reservable; cap exceeded → 422 with remaining allowance, and the cap check is atomic with the claim; hold self-expires, no sweeper |
| 2 | Tue 08-19 | `GET /events/:id/seatmap` on Event Service; read logic in shared `lib/availability` | 35 min | **Redis round-trip count identical at 50 and 50,000 tickets** (asserted via Week-0 counter); expired holds don't render as held; booked beats held; your-hold vs others'-hold distinguished; **grep confirms Event Service writes zero hold keys** |
| 3 | Wed 08-20 | `GET /events/:id/stream` on Event Service + Redis pub/sub from Booking Service | 35 min | 2 clients update within ~1s of a third's reserve; **reserve published by Booking Service reaches clients on both Event Service instances**; publisher doesn't block or know subscriber count; reconnect snapshot uses the same `lib/availability`; SSE module imports nothing from CRUD; **kill and restore Redis → subscriber reconnects without process restart** |
| 4 | Thu 08-21 | Cold rebuild: hold mechanism + seat-map read path, blank file | 35 min | passes Day 1 and Day 2 tests including the round-trip assertion |
| 5 | Fri 08-22 | Outreach + blockers log | — | log written |

**Retest (spaced):** Week 1 booking guard, cold, ~10 min.

**Day 1 is overloaded** — atomic claim, all-or-nothing, per-user cap, and idempotent retry in one box. Cap and idempotency are small but the *atomicity* of the cap check is the subtle part. If you overrun, the cap is the piece to push to Day 4's rebuild slot; never drop the atomicity.

---

## Week 3 — Pagination, cache, search + CDC (08-25 → 08-29)

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Mon 08-25 | `GET /events` offset + keyset pagination | 35 min | `limit=100000` capped at 100; next cursor returned; empty page → `200+[]`; composite `(event_date, id)` cursor with written justification |
| 2 | Tue 08-26 | Redis cache-aside on `GET /events/:id` + invalidation | 35 min | hit faster than DB (both logged); TTL set; PUT/DELETE invalidates; **seat map never served from this cache**, with written boundary |
| 3 | Wed 08-27 | Search Service (separate process) + Elasticsearch index and query | 35 min | `"conc"` finds `"Concert"`; 1-char typo matches; term+location+date combine; `term=""` doesn't crash; no match → `200+[]`; returns partials |
| 4 | Thu 08-28 | Transactional outbox + poller → Elasticsearch | 35 min | new event searchable with no direct ES write from Event Service; kill poller mid-batch → no loss, no dupes; **ES down → event write still succeeds**, drains on recovery; two pollers → no double-publish |
| 5 | Fri 08-29 | Outreach + blockers log | — | log written |

**Retest (spaced):** Week 2 hold mechanism, cold, ~10 min.

**Day 3 pre-work, untimed, do it the night before:** write and run one working ES index-and-query by hand. Learning the query DSL and doing a 35-min cold build are separate exercises; combining them guarantees an overrun.

---

## Week 4 — API Gateway, auth, authz, rate limiting (09-01 → 09-04)

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Tue 09-01 | Gateway routing/proxy + correlation IDs | 35 min | service ports not externally reachable; **SSE streams unbuffered and survives the upstream timeout**; downstream down → 503 in your error shape; per-upstream timeout; **one correlation ID traces gateway → booking → pub/sub → SSE** |
| 2 | Wed 09-02 | Auth Service: register + login, access JWT (carries `role`) + opaque refresh | 35 min | dup email → 409; wrong password → 401; slow KDF; **KDF runs even for unknown emails** so timing doesn't leak existence |
| 3 | Thu 09-03 | Gateway authn + authz: JWT verify, `X-User-Id`/`X-User-Role` injection, refresh, logout | 35 min | expired/tampered token → 401 at gateway, never reaches service; **client-supplied `X-User-Id` AND `X-User-Role` both stripped and overwritten**; `role=user` on `POST /events` → **403 not 401**; revoked refresh token → 401 |
| 4 | Fri 09-04 | Sliding-window rate limiter at gateway, on search + booking | 35 min | N+1th → 429 + `Retry-After`; window slides (not fixed-bucket reset); 2 gateway instances share state; increment+check atomic; **keyed on injected `userId`, so it runs after auth**; Stripe webhook exempt from both auth and limiting, with written reason |
| 5 | — | Outreach + blockers log | — | log written |

**Note:** Mon 08-31 assumed off/buffer. Working it → shift each row back one day, reclaim Day 5.

**Retest (spaced):** Week 3 outbox poller, cold, ~10 min.

**Day 1 is the most likely overrun of the whole plan.** SSE-through-proxy and correlation-ID propagation across six processes both break for the first time here. If you're going to blow a time box, expect it to be this one — don't count it as failure, log what broke.

---

## Week 5 — Waiting room, fairness, cancellation (09-08 → 09-12)

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Mon 09-08 | `POST /queue/join` + `GET /queue/position` | 35 min | position **never increases** across polls; token signed and bound to `userId+eventId`, cross-user token → 401; double-join takes one slot; ETA from measured drain rate, returned as a range |
| 2 | Tue 09-09 | Admitter worker + admission gate on Booking Service | 35 min | reserve without admission → **403 with zero Redis calls on the reject path**; budget from inventory + active holds, not fixed rate; **two admitters → still no over-admission**; kill/restart resumes cleanly; **SIGTERM releases the lease** so restart doesn't wait it out; sold-out drains queue instead of stranding it |
| 3 | Wed 09-10 | Fairness: registration window + randomized draw | 35 min | position/join-time correlation **measured** across 1000 registrants, not eyeballed; seed unguessable pre-open; FIFO behind a flag; written FIFO vs lottery vs weighted |
| 4 | Thu 09-11 | `POST /bookings/:id/cancel` (refund stubbed) + waitlist | 35 min | cancel releases every ticket, each immediately reservable; publishes to pub/sub so open SSE clients see seats reopen live; cancel idempotent — twice → one release, one notification; cancel on already-cancelled → 409; released ticket notifies **exactly one** waitlist user with a claim window, unclaimed → next |
| 5 | Fri 09-12 | Load test + outreach + blockers log | 35 min | 10k joins → zero 500s, zero over-admission; **actual Postgres connection count recorded against `max_connections`**; written note on the first real bottleneck; written WebSocket vs SSE vs long-poll cost at 1M clients |

**Retest (spaced):** Week 4 rate limiter, cold. Then write the difference between rate limiting and admission control. Can't state it → you learned neither.

**Cancellation is here, not in Week 6, on purpose.** The waitlist has no supply without it — an expired hold was never sold, so nobody is waiting on it. Refund is stubbed this week; Week 6 Day 1 wires the real Stripe call.

---

## Week 6 — Payment, failure modes, reconciliation (09-15 → 09-18)

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Mon 09-15 | Payment + real refund wired into Week 5's cancel | 35 min | **`total_amount` server-derived — request claiming ₹1 for a ₹5000 ticket still charges ₹5000**; `payments` row written before Stripe call; same idempotency key twice → one charge (verified in Stripe dashboard); confirm re-verifies hold ownership AND `status='available'`; charged-but-hold-expired → auto-refund; ticket flip + `booking_items` + booking row in one txn; cancel on confirmed → `refunded` not `cancelled` |
| 2 | Tue 09-16 | Stripe webhook as second confirmation path | 35 min | **bad signature → 400, no state change**; duplicate delivery → one state change; `succeeded` after `refunded` doesn't corrupt — guard on transition not arrival order; webhook racing sync path → same terminal state |
| 3 | Wed 09-17 | Failure injection drill — predict in writing first, then break it | 35 min | all eight scenarios in REQUIREMENTS Week 6 Day 3 pass; every wrong prediction logged |
| 4 | Thu 09-18 | Reconciler: pending-payment sweeper + Redis/Postgres drift detector | 35 min | every Day-3 injected inconsistency resolved; no booking left pending; drift emitted as a metric; safe to run twice and safe under live traffic |
| 5 | Fri 09-18 | Recorded unscripted walkthrough + final blockers log | 30 min | covers all six points below with no notes |

**Walkthrough must cover, unscripted:**
1. Three-layer double-book guard — Redis hold, conditional `UPDATE`, `UNIQUE(ticket_id)`. What each stops, what happens when each fails.
2. Why holds live in Redis and money lives in Postgres.
3. Why the seat map costs the same at 50 seats and 50,000.
4. Dual-write problem and how the outbox solves it.
5. Why FIFO isn't fair.
6. Why `POST /webhooks/stripe` is the one endpoint with no auth and no rate limit.

---

## Optional Week 7 — Sharding (09-22 → 09-25)

Only if Weeks 1–6 all cold-passed twice.

| Day | Date | Task | Time box | Done when |
|-----|------|------|----------|-----------|
| 1 | Tue 09-22 | Consistent hashing, standalone, blank file | 35 min | even distribution across N nodes; adding a node moves ~1/N of keys, **measured** |
| 2 | Wed 09-23 | Wire as event/ticket partitioning + same-day cold rebuild | 35 + 30 min | routing hits correct partition; rebuild passes Day 1 tests |
| 3 | Thu 09-24 | Cold rebuild of weakest component across Weeks 1–6 | 35 min | passes its acceptance tests |
| 4 | Fri 09-25 | Final log + decide repeat vs extend | — | log written |

Deprioritized deliberately: the read bottleneck here is Elasticsearch, the write bottleneck is per-event hold contention, and sharding by `event_id` fixes neither — a hot event is one shard regardless of shard count. Build it for interview recall and say exactly that.

---

## Retest ledger (fill as you go)

| Component | Built | Retest 1 | Retest 2 |
|-----------|-------|----------|----------|
| CRUD + validation + error shape | 08-11 | | |
| Booking confirm guard (3-layer) | 08-12 | 08-14 | Week 2 |
| Redis hold (atomic, TTL, cap, idempotent) | 08-18 | 08-21 | Week 3 |
| Seat-map read (constant round trips) | 08-19 | 08-21 | |
| SSE + pub/sub fan-out | 08-20 | | |
| Keyset pagination | 08-25 | | |
| Event cache + invalidation | 08-26 | | |
| Elasticsearch index + query | 08-27 | | |
| Outbox + CDC poller | 08-28 | Week 4 | |
| Gateway routing + correlation IDs | 09-01 | | |
| Auth: register/login | 09-02 | | |
| JWT verify / authz / refresh / logout | 09-03 | | |
| Rate limiter (sliding window) | 09-04 | Week 5 | |
| Queue join + position | 09-08 | | |
| Admitter / admission control | 09-09 | | |
| Fairness draw | 09-10 | | |
| Cancellation + waitlist | 09-11 | | |
| Payment idempotency + server-side amount | 09-15 | | |
| Webhook handling | 09-16 | | |
| Reconciler | 09-17 | | |

**Rule:** component not cold-passed twice, spaced ≥3 days = not learned. Reschedule it into the next Day-5 slot.

**Single-pass components going into Week 6:** SSE fan-out, Elasticsearch, gateway + correlation IDs, auth, authz, and all five Week 5 days. By your own rule those aren't learned. That's the honest cost of 6 weeks instead of 8. If a slot frees up, spend it on **SSE fan-out** and the **admitter** — subtlest failure modes, and both are the kind of thing that passes casually and breaks under two instances.

---

## Weak spots — know them before an interview asks

- **Single-node everything.** One Postgres, one Redis, one Elasticsearch. No replication, no failover. Multi-instance tests are multiple local processes, not machines or network partitions.
- **Shared database across services.** Event Service and Booking Service both read `tickets`. Split-by-process, not real service isolation — the data coupling is still there, you added network hops. Real boundaries mean a DB per service, which turns booking↔ticket into a distributed transaction. Deliberate trade. When asked "who owns the tickets table?", answer "shared, and that's the compromise I made."
- **CDC is a poller.** Debezium + Kafka is the production answer; you can describe it, not demo it.
- **Pub/sub is at-most-once.** Subscriber down = notification gone. You'll have built a durable path — be ready to say why you'd swap it in for anything that matters.
- **SSE on Event Service** means an Event Service deploy drops every open stream, and a socket leak takes CRUD down with it. Accepted so that availability logic exists once instead of twice.
- **Stripe test mode only.** Idempotency logic is real; real provider partition behavior is not exercised.
- **No Kafka, no service mesh, no k8s.** If the role wants deployed distributed infra, this project doesn't show it. Say so.
- **Bots.** Per-user caps and payment-instrument uniqueness are in scope. Nothing here stops an attacker with 10,000 verified identities — that's identity verification, out of scope. Name it; it's the part real Ticketmaster still loses.

# Demo service: Stripe webhook fulfillment (intentionally buggy)

`POST /webhook` takes a Stripe-like `payment_intent.succeeded` event and appends it to an in-memory ledger.

Planted bugs, which the builder agents must fix:

1. **No idempotency by `event.id`.** Stripe retries deliveries, so duplicates double-charge the ledger.
2. **A 50 ms `await` between the work and the ledger write.** The naive fix (`if (seen.has(id)) return; await work(); seen.add(id)`) still loses to concurrent duplicates. A correct fix marks the id in flight before the await.
3. **Malformed bodies crash the process** (`JSON.parse` throws inside an async handler). They should return 4xx.

`npm start` listens on `PORT` (default 8080) on 0.0.0.0. `npm test` proves the bug locally.

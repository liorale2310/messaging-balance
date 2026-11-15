# Decisions

These are the questions the brief leaves open. They are ordered by how much they change the design. Each one records the question, the assumption this core ships with, why that assumption is the one to recommend, and what would change if the answer were different.

## 1. When is credit committed?

**Question.** Does a campaign hold credit when it is drafted, when it is scheduled, or only when it is sent?

**Assumption.** Credit is committed at schedule time. Draft edits do not hold credit. A scheduled campaign holds one credit per recipient.

**Why.** The customer is often away when the campaign is due. Reserving only at send time would let two campaigns promise the same credit, and one would fail while nobody is there to choose. Reserving at draft time would block other campaigns the customer has not committed to.

**What would change.** A send-time hold would remove reservation rows and would make `sendDue` the place that can refuse for lack of credit. A draft-time hold would make every recipient edit a balance movement.

## 2. What happens when a due campaign is short?

**Question.** If a scheduled campaign is no longer fully funded at send time, do we send the funded part, leave it scheduled, or refuse it once?

**Assumption.** A due campaign is sent once, all or nothing. `sendDue(at)` either records every recipient as ready for the dispatcher, or marks the campaign `NOT_SENT` with a frozen reason and releases its holds. A later `sendDue` does not retry it.

**Why.** A partial send needs a rule for which recipients lose, and still leaves some of them unsent. Leaving the campaign scheduled until a later top-up could send it after the event the customer cannot miss.

**What would change.** Partial send would need a victim-selection rule and message rows for only some recipients. A retry-until-funded policy would keep the campaign `SCHEDULED` and would not store `not_sent_reason`.

## 3. Can an order be cancelled after its credit is in use?

**Question.** Is cancellation refused once credit is reserved or accepted, or does cancellation always stand?

**Assumption.** Cancelling an order is always allowed, including when that order's credit is reserved or already accepted. The lot leaves availability. Holds on that lot are moved onto other active orders, oldest lot first. Holds that cannot move become a scheduled shortfall or an in-flight message with no backing order. Accepted messages that cannot move stay debt.

**Why.** Refusing cancellation would hide refunds and chargebacks. Folding the shortfall into a negative "available" number would make the dashboard unable to say why a campaign will not go out.

**What would change.** A refusal would stop at reserved or consumed credit and would not need re-homing, shortfall notes, or debt. A single negative balance would delete those explanations.

## 4. Which obligations does new or freed credit pay first?

**Question.** When credit becomes free, what does it cover before the customer can schedule something else?

**Assumption.** Orders are FIFO lots, oldest `placed_at` then order id. One function, `coverOutstanding`, applies free capacity in this order: unbacked in-flight messages, then the earliest scheduled shortfall, then the oldest debt. The remainder is available.

**Why.** This is ordinary control flow inside the service, not a rules engine. Scheduled work is covered before old debt so a top-up saves the campaign that is about to be missed. Paying debt first would do the opposite. A single customer counter could not explain which order was cancelled.

**What would change.** Debt-first settlement would reorder `coverOutstanding` and could leave a scheduled campaign short while available credit pays an old acceptance. A single counter would remove lots, reservation rows, and per-order dashboard lines.

## 5. What must the dispatcher send with a result?

**Question.** How does the core tell a duplicate or a reordered provider result from a new one?

**Assumption.** The dispatcher is not part of this core. Every handoff report includes a globally unique event id, the message id created at dispatch, an outcome of `ACCEPTED` or `REJECTED`, and a sequence. The sequence is a positive integer that the dispatcher increases monotonically for successive results of that same message. The core does not invent sequence numbers and does not order reports by arrival time. Gaps are allowed: sequence 3 still applies if 2 was never delivered.

**Why.** Arrival time is not an order. Without an event id, a retry is indistinguishable from a new result. Without a per-message sequence, a late rejection can overwrite a newer acceptance.

**What would change.** If the dispatcher cannot provide a unique event id and a monotonic per-message sequence, duplicate and out-of-order results are undefined. The core would have to switch to sticky-accept or refuse reports it cannot order.

## 6. Which result wins when several arrive?

**Question.** Is a repeated event a success, a conflict, or a second charge? Does an older sequence replace the outcome?

**Assumption.** Event identity is decided before the sequence is compared. The same event id with the same message id, outcome, and sequence is an idempotent success and writes nothing new. The same event id with any of those three fields different raises `HANDOFF_CONFLICT` and writes nothing. A different event id that reuses an already-stored `(messageId, sequence)` raises `HANDOFF_CONFLICT` and is not stored. A new event whose sequence is strictly lower than the sequence already applied to the message is stored and does not change the message outcome or credit. A new event with a strictly higher sequence is applied. `ACCEPTED` or `REJECTED` replaces the other. A later rejection releases the credit. A later acceptance charges it from free capacity only, or records debt when none remains. It does not take credit already reserved for another campaign. Equality is not the stale-sequence case: the sequence already applied was stored with the event that applied it, so a second event id at that same sequence is the conflict above.

**Why.** Comparing the event id alone would hide a dispatcher bug as a successful no-op. Treating an equal sequence as stale would also hide that bug. Charging a late acceptance from reserved credit would cancel another campaign's hold.

**What would change.** Sticky-accept would ignore a later rejection. Last-arrival-wins would drop the sequence column. Taking reserved credit on a late accept would shrink another campaign's reservation inside the handoff transaction.

## 7. Can available credit go negative?

**Question.** Is debt just a negative available balance?

**Assumption.** Available credit never goes below zero. Debt is separate. Scheduling, and adding a recipient to a scheduled campaign, are refused when `available` is short. The refusal names available, reserved, and debt. Debt is created only by a cancelled order's already-accepted messages, or by a late acceptance after the released credit was reused.

**Why.** Letting available go negative would make "can I schedule this?" ambiguous. The customer needs to see that the campaign is blocked and that an old acceptance is unpaid, as two different facts.

**What would change.** A negative available balance would remove the debt figure and the refusal would no longer be able to name both.

## 8. How many times is a campaign handed to the dispatcher?

**Question.** Is there a completed state, and can the customer change the send time in place?

**Assumption.** One campaign is handed to the dispatcher at most once. Statuses are `DRAFT`, `SCHEDULED`, `DISPATCHED`, and `NOT_SENT`. There is no `COMPLETED` status. Pending, accepted, and rejected counts on the balance already say whether the handoff is finished, and a later sequence must still be able to change credit. Cancel schedule is allowed only from `SCHEDULED` and returns the campaign to `DRAFT`. Changing the send time means cancel, then schedule again. The same `scheduledAt` replay is a no-op. Recipients can change in `DRAFT` freely, and in `SCHEDULED` only when the credit movement succeeds. The list freezes at `DISPATCHED`. An empty campaign cannot be scheduled. A send time in the past is allowed and becomes due on the next `sendDue`.

**Why.** A completed status would freeze the outcome even though a later provider sequence can still accept or reject. Editing a dispatched list would change messages the dispatcher may already hold.

**What would change.** A `COMPLETED` status would close the handoff and reject later sequences. In-place reschedule would update `scheduled_at` without releasing the hold. Partial recipient edits after dispatch would need a rule for messages that already exist.

## 9. Who chooses the ids, and what is a replay?

**Question.** Are order and campaign ids generated here, and is repeating a call a second write?

**Assumption.** Order and campaign ids are caller-supplied idempotency keys. The same order id with the same customer and quantity replays successfully. A different payload for that id conflicts. The same rule applies to creating a campaign. `sendDue` is safe to run twice because the status transition happens inside the customer lock. Handoff event ids follow decision 6.

**Why.** The caller retries. A generated id would make the retry a second order. A conflict must not look like success, or a retry with a corrupted payload would be stored as the original.

**What would change.** Server-generated ids would drop the conflict branch and would need another idempotency key to make retries safe.

## 10. How are concurrent workers kept off the same credit?

**Question.** What is locked, and in what order?

**Assumption.** Concurrency is a customer row lock, taken first, under Read Committed. Lock order is customer, then orders by id, then campaigns by id, then messages by id. `sendDue` handles one customer per transaction and re-reads due campaigns inside that lock. There is no in-memory balance.

**Why.** Two schedules against one remaining credit must end with a single reservation. Locking campaigns before customers would deadlock with scheduling. An in-memory balance would be wrong on the second application server.

**What would change.** A balance cache would need invalidation across servers. A campaign-first lock would need a different global order or deadlock retry. `SKIP LOCKED` on the customer would let `sendDue` miss a campaign that is being scheduled.

## 11. Where do the dashboard numbers and sentences come from?

**Question.** Is the balance a stored document, a ledger, or a projection of the current rows?

**Assumption.** The balance is a projection of current rows, plus one frozen sentence. Counts are derived inside the locked transaction. Order rows do not cache reserved or consumed counters. There is no ledger table and no event store. Each mutating transaction ends by asserting conservation. A campaign stores `not_sent_reason` when send is refused, because the holds are released and the cause would otherwise disappear. While a scheduled campaign is short, it stores `funding_note`, including the cancelled order that caused the shortfall. Debt and unbacked in-flight text are rendered from current rows.

**Why.** A stored balance blob would drift from the rows. The frozen sentence is the one fact that disappears when the holds are released. A history log is the change to make if the dashboard must show past movements rather than the current position.

**What would change.** A ledger or event store would add a table and would make the balance a fold over history. Cached counters on the order would have to move inside the same transaction as the rows they summarize.

## 12. Which recipient is charged to which order?

**Question.** When a campaign is dispatched, how are reserved lots paired with recipients?

**Assumption.** Before send, a reservation is a quantity on `(campaign, order)`. At send, recipients are sorted by `created_at` ascending, then recipient id ascending. Lots already reserved to that campaign are sorted by `placed_at` ascending, then order id ascending. Walking the recipients in order, each takes the next credit from the oldest lot that still has remaining quantity. Message rows do not exist before this step.

**Why.** Address order is not used, because collation would change who is charged to which order. A stable sort keeps a replay of `sendDue` from assigning a different order if the assignment were ever rebuilt. It is not rebuilt: the second call sees `DISPATCHED` and leaves the messages alone.

**What would change.** Sorting by address would make the assignment depend on database collation. Creating message rows at schedule time would move this pairing earlier and would give drafts a message table.

## 13. What is deliberately not in this core?

**Question.** Which adjacent product behaviors are out of scope?

**Assumption.** There is no accounting HTTP API, dispatcher, provider client, notifications, auth, or cron. There is no message body, currency, price other than 1 credit, partial order cancel, or expiry. The first `placeOrder` creates the customer. A recipient is a trimmed non-empty string, unique per campaign, with no phone-format canonicalization. Send selection uses the caller's `at`, not the server clock. Order quantity is a positive integer up to 1,000,000.

**Why.** The brief asks for the accounting core and the dashboard facts it can show. The other pieces are real, and they are not this component. The caller supplies `at` so a test and a worker can agree on what "due" means.

**What would change.** An HTTP API would add controllers and auth. A price other than 1 credit would replace recipient counts with money. Partial cancel would split a lot. Phone canonicalization would change the unique key on recipients. Using the server clock inside `sendDue` would make the due set depend on which machine ran it.

## 14. Which database may tests truncate?

**Question.** How do we keep a test run from wiping the development database?

**Assumption.** Database tests run only against a database whose name ends in `_test`. Schema changes go through TypeORM migrations only. `synchronize` stays off.

**Why.** The suite truncates between cases. A name check is a hard stop before that truncate. Migrations keep the test database and the application database on the same schema.

**What would change.** `synchronize: true` would let the test schema drift from the migration that production runs. Dropping the name check would make a mis-set `DB_NAME` able to truncate the development database.

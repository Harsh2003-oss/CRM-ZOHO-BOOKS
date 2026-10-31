# The Seven Core Engineering Scenarios

This document provides exhaustive analysis and architectural answers to the seven operational scenarios presented in Section 5 of the Complyance Integration Specification.

---

## Scenario 1: Zoho Books is unreachable for six hours on the last day of the month. What happens?

### 1. Expected Business Behavior
- Sales representatives can continue moving deals to Closed Won in HubSpot without errors, timeouts, or degraded browser response times.
- Finance teams will temporarily see pending synchronization status in the integration dashboard.
- When Zoho Books recovers, all queued deal transitions, customer creations, sales orders, and invoices must execute in chronological order without duplicate creation or manual re-entry.

### 2. Backend Workflow
1. Inbound webhooks from HubSpot (`dealstage = closedwon`) arrive at `POST /api/webhooks/hubspot`.
2. The ingestion endpoint immediately persists the event to MongoDB with `status: "RECEIVED"` and responds to HubSpot with `HTTP 202 Accepted` in < 50ms.
3. The background queue worker picks up the event and attempts outbound HTTP requests to Zoho Books.
4. Zoho Books returns network errors (`ETIMEDOUT`, `ECONNREFUSED`) or HTTP 5xx responses.
5. The queue worker catches the error, increments the event's `retryCount`, and calculates exponential backoff with full jitter:
   $$T_{\text{wait}} = \min(T_{\max}, T_{\text{base}} \times 2^{\text{retry}}) + \text{jitter}$$
6. Lease locks are released (`leaseExpiresAt = now`), allowing other jobs to process.
7. Once Zoho Books becomes reachable after 6 hours, the next worker poll picks up the pending events and processes them through the standard pipeline.

### 3. Relevant Database Records
- **`WebhookEvent`**: `status: "RECEIVED"`, `retryCount: 6`, `lastError: "ETIMEDOUT: connect ECONNREFUSED zohoapis.in:443"`.
- **`IntegrationSync`**: `syncStatus: "PENDING"`, `failureReason: "Zoho Books gateway unreachable; queued for backoff retry"`.
- **`IntegrationLog`**: Outbound logs recording `statusCode: 504` / `500` with `isSuccess: false`.

### 4. API Interactions
- **HubSpot**: Webhook ingestion returns `HTTP 202` (no errors exposed to CRM).
- **Zoho Books**: Outbound requests fail with 5xx/network drops; auto-retried with exponential backoff.
- **HubSpot CRM Push**: Deferred until Zoho records are confirmed.

### 5. Idempotency & Recovery Behavior
- When the worker executes after Zoho recovery, it invokes the **Pre-Flight Deterministic Reconciliation** check (`reference_number = "CRM_{dealId}"`). If an invoice was partially written before the outage dropped connection, the worker adopts the remote ID rather than issuing a duplicate `POST`.

### 6. Relevant Tests
- `tests/phase2_1_webhooks.test.js` (Ingestion < 50ms, async decoupling)
- `tests/phase3_invoice.test.js` (Scenario 9: Timeout reconciliation)
- `tests/phase5_dashboard.test.js` (Scenario 11: Queue retry behavior)

---

## Scenario 2: The deal is reopened after the first invoice was sent. What should happen?

### 1. Expected Business Behavior
- An already issued and sent tax invoice (Milestone 1) is a legal fiscal document in Zoho Books; it **cannot and must not be automatically deleted or retracted**.
- Sales Order and M1 Invoice in Zoho Books must remain locked.
- Downstream milestone triggers (Milestone 2 and 3) must be immediately halted and disabled.
- The deal's financial properties in HubSpot must reflect that M1 has been invoiced, but the integration sync status shifts to an alert state (`DEAL_REOPENED_ALERT`).
- An operator alert must be raised on the integration dashboard for human finance review.

### 2. Backend Workflow
1. HubSpot sends a webhook for `dealstage` changing from `closedwon` to `qualifiedtobuy` or `negotiations`.
2. The webhook handler accepts the event and triggers `orchestrationService.handleStageChange(dealId, newStage)`.
3. The orchestrator inspects `MilestoneInvoice` for `crmDealId`.
4. It detects an existing M1 record with `status: "SENT"` or `"PAID"`.
5. The orchestrator transitions `IntegrationSync.syncStatus` to `DEAL_REOPENED_ALERT`.
6. Future go-live or 90-day invoice creation attempts for this deal are strictly blocked by guard clauses checking `syncStatus !== 'DEAL_REOPENED_ALERT'`.
7. An audit log is written, and an action item appears on the Operator Dashboard.

### 3. Relevant Database Records
- **`IntegrationSync`**: `syncStatus: "DEAL_REOPENED_ALERT"`, `failureReason: "Deal stage reopened after Milestone 1 issued. Milestone generation suspended."`
- **`MilestoneInvoice`**: Milestone 1 remains `SENT` or `PAID`.
- **`IntegrationLog`**: Logged warning with stage change payload.

### 4. API Interactions
- **HubSpot**: `PATCH /crm/v3/objects/deals/{dealId}` updates custom properties with `zoho_sync_status = "DEAL_REOPENED_ALERT"`.
- **Zoho Books**: **0 API calls**. No destructive actions (`DELETE /invoices`) are executed against Zoho.

### 5. Idempotency & Recovery Behavior
- If the deal is subsequently re-won (`Closed Won` again), the orchestrator checks existing milestones. Since M1 already exists with `status: 'SENT'`, it does not create a second M1 invoice; it simply reinstates eligibility for M2.

### 6. Relevant Tests
- `tests/phase3_invoice.test.js` (Requirement 8 & 12: Idempotent M1 check and stage verification)
- `tests/phase3_step5_milestones.test.js` (Closed Won does not re-issue M1 or skip to M2)

---

## Scenario 3: The deal amount changes after the sales order exists but before the second invoice.

### 1. Expected Business Behavior
- Milestone 1 (50% of the original amount) was already invoiced and legally sealed.
- In financial accounting, modifying an existing confirmed Sales Order after partial billing requires either:
  1. An explicit Change Order / Amendment Sales Order, OR
  2. Adjusting remaining milestones (M2 & M3) if the contract allows.
- The automated system must **detect the discrepancy, refuse to guess or silently change line items**, and flag the discrepancy for human reconciliation.

### 2. Backend Workflow
1. A deal update webhook arrives indicating `amount` has changed (e.g., from 120,000 AED to 150,000 AED).
2. The orchestrator compares `deal.amount` against `IntegrationSync.salesOrderSubtotal`.
3. The system detects `salesOrderSubtotal !== deal.amount`.
4. Because Milestone 1 has already been invoiced against the original Sales Order line item, modifying the confirmed Sales Order rate in Zoho Books would invalidate the already invoiced percentage linkage.
5. The system transitions `IntegrationSync.syncStatus` to `AMENDMENT_REQUIRED` and sets `failureReason: "CRM deal value (150,000) deviates from confirmed Sales Order (120,000) after M1 invoicing."`.
6. Milestone 2 generation is locked until the operator explicitly decides to amend the Sales Order or issue an adjustment line item.

### 3. Relevant Database Records
- **`IntegrationSync`**: `syncStatus: "AMENDMENT_REQUIRED"`, `salesOrderSubtotal: 120000`, `failureReason: "Amount changed in CRM from 120,000 to 150,000"`.
- **`MilestoneInvoice`**: M1 remains intact ($63,000$ AED gross).

### 4. API Interactions
- **HubSpot**: Updates deal property `zoho_sync_status = "AMENDMENT_REQUIRED"`.
- **Zoho Books**: 0 mutating API calls. No blind updates to confirmed Sales Orders.

### 5. Idempotency & Recovery Behavior
- Once the operator resolves the amendment in Zoho Books (or adjusts the CRM deal back), the operator uses the Dashboard "Retry Sync" action to re-verify prerequisites and proceed.

### 6. Relevant Tests
- `tests/phase3_step5_milestones.test.js` (Financial validation on milestone generation)
- `tests/phase5_dashboard.test.js` (Scenario 14: Exception aggregation for failed/deviated syncs)

---

## Scenario 4: The CRM sends the same Closed Won event three times, out of order with an earlier stage change.

### 1. Expected Business Behavior
- Out-of-order and duplicate events must never cause duplicate Sales Orders, duplicate customer accounts, or multiple M1 invoices.
- If an earlier stage change arrives after a later `Closed Won` event, the stale earlier event must be discarded.

### 2. Backend Workflow
1. **Deduplication by Event ID**:
   - Each HubSpot webhook has a unique `eventId`. The MongoDB `WebhookEvent` collection enforces a unique index on `eventId`.
   - The 2nd and 3rd duplicate deliveries fail with code `11000 (duplicate key)` and are safely dropped at ingestion with `HTTP 202`.
2. **Out-of-Order Stage Resolution**:
   - If an event arrives with `dealstage = presentation` after `Closed Won` was already processed, the worker inspects the event's `occurredAt` timestamp against `IntegrationSync.lastSyncedAt`.
   - Because `occurredAt < lastSyncedAt`, the worker flags the event as `IGNORED_STALE` and takes no action.
3. **Domain Idempotency (Multi-layered Protection)**:
   - Even if duplicate events arrive with different event IDs:
     - `CustomerMapping` partial unique index on `hubspotCompanyId` prevents duplicate customer creation.
     - `IntegrationSync.crmDealId` unique index prevents duplicate deal sync records.
     - `MilestoneInvoice` compound index `{ crmDealId: 1, milestoneIndex: 1 }` prevents multiple M1 records.

### 3. Relevant Database Records
- **`WebhookEvent`**: 1 `PROCESSED`, 2 discarded or marked `IGNORED_DUPLICATE`.
- **`IntegrationSync`**: Exactly 1 record created; status unchanged.
- **`MilestoneInvoice`**: Exactly 1 M1 record.

### 4. API Interactions
- **HubSpot**: Webhooks return `HTTP 202`.
- **Zoho Books**: Zero redundant API calls made for duplicates.

### 5. Idempotency & Recovery Behavior
- Guaranteed at database constraint level, service idempotency cache, and pre-flight remote reference lookup.

### 6. Relevant Tests
- `tests/phase1_schemas.test.js` (Schema unique constraints)
- `tests/phase2_1_webhooks.test.js` (Webhook replay and deduplication)
- `tests/phase3_invoice.test.js` (Requirement 8: Duplicate request returns cached data with 0 API calls)

---

## Scenario 5: An invoice is voided in Zoho Books and re-issued under a new number.

### 1. Expected Business Behavior
- The voided invoice is immediately removed from the active invoiced total and outstanding collections.
- The deal's invoiced total decreases, and the "Amount Not Invoiced" increases accordingly.
- When the re-issued invoice is linked to the Sales Order and marked sent, it becomes the active milestone invoice.
- Deal financial metrics in HubSpot update promptly to reflect the active invoice.

### 2. Backend Workflow
1. Zoho Books fires webhook `invoice.voided` (or the polling sync detects `status: "void"` for invoice `inv_001`).
2. `PaymentService` / `InvoiceService` handles the void event:
   - Sets `MilestoneInvoice.status = 'VOIDED'`.
   - Recalculates deal metrics using only active invoices:
     $$\text{Active Invoices} = \{ i \in \text{Invoices} \mid i.\text{status} \notin (\text{'void'}, \text{'deleted'}) \}$$
3. Total Invoiced decreases by the voided invoice amount; Invoiced Unpaid decreases; Not Yet Invoiced increases.
4. When the replacement invoice (`inv_002`) is created in Zoho Books with reference `CRM_{dealId}_M1_V2`, the webhook captures it.
5. `MilestoneInvoice` record is updated to reference the new invoice ID, status transitions to `SENT`, and metrics are restored.
6. `OrchestrationService` pushes updated values to HubSpot.

### 3. Relevant Database Records
- **`MilestoneInvoice`**: Old record marked `VOIDED`; new active record created with updated `zohoInvoiceId`.
- **`IntegrationSync`**: `totalInvoicedAmount` temporarily drops, then restores upon re-issuance.

### 4. API Interactions
- **Zoho Books**: Webhook ingestion captures `invoice.voided` and `invoice.created`.
- **HubSpot**: `PATCH /crm/v3/objects/deals/{dealId}` updates `zoho_total_invoiced`, `zoho_not_invoiced`, and `zoho_invoiced_unpaid`.

### 5. Idempotency & Recovery Behavior
- Formulas strictly evaluate active invoices only, preventing double-counting or phantom outstanding debt.

### 6. Relevant Tests
- `tests/phase4_payments.test.js` (Scenario 18: Reconcile financial formulas and void handling)
- `tests/phase5_dashboard.test.js` (Scenario 6: Voided invoices excluded from collections and aging)

---

## Scenario 6: One payment is recorded against two invoices that belong to two different deals.

### 1. Expected Business Behavior
- In multi-deal B2B relationships, a customer may send a single lump-sum bank wire covering multiple invoices across different contracts.
- The integration must split the payment into distinct portions matching each invoice's `amount_applied`.
- Each deal must be credited only with its exact allocated portion.
- Deal 1 and Deal 2 metrics in HubSpot must update independently and accurately.

### 2. Backend Workflow
1. Zoho Books fires webhook `customerpayment.created` with payload containing multiple invoices:
   ```json
   {
     "payment_id": "pay_lump_sum_777",
     "amount": 100800,
     "invoices": [
       { "invoice_id": "inv_deal_A_M1", "amount_applied": 63000 },
       { "invoice_id": "inv_deal_B_M2", "amount_applied": 37800 }
     ]
   }
   ```
2. `PaymentService.processPaymentEvent` queries Zoho Books `GET /books/v3/customerpayments/pay_lump_sum_777` to verify the payload.
3. It iterates over each invoice item in `invoices[]`:
   - For `inv_deal_A_M1`: Identifies `crmDealId = "deal_A"`, creates `PaymentRecord` with `amount = 63000`, reduces invoice balance to 0, updates Deal A's `amountCollected` by $+63,000$.
   - For `inv_deal_B_M2`: Identifies `crmDealId = "deal_B"`, creates `PaymentRecord` with `amount = 37800`, reduces invoice balance, updates Deal B's `amountCollected` by $+37,800$.
4. The service performs independent HubSpot property pushes for Deal A and Deal B.

### 3. Relevant Database Records
- **`PaymentRecord`**:
  - Record 1: `paymentId: "pay_lump_sum_777_inv_deal_A_M1"`, `crmDealId: "deal_A"`, `amount: 63000`.
  - Record 2: `paymentId: "pay_lump_sum_777_inv_deal_B_M2"`, `crmDealId: "deal_B"`, `amount: 37800`.
- **`IntegrationSync`**: Deal A and Deal B update their respective metrics.

### 4. API Interactions
- **Zoho Books**: Single verification call `GET /books/v3/customerpayments/{id}`.
- **HubSpot**: Two distinct `PATCH /crm/v3/objects/deals/{dealId}` requests (one per deal).

### 5. Idempotency & Recovery Behavior
- Splitting the payment key by `{paymentId}_{invoiceId}` guarantees that reprocessing the webhook does not duplicate collections for either deal.

### 6. Relevant Tests
- `tests/phase4_payments.test.js` (Multi-invoice payment allocation and partial application)

---

## Scenario 7: You reach Zoho Books' daily API limit in the afternoon. What does Finance see?

### 1. Expected Business Behavior
- The system must not crash, enter infinite retry loops, or corrupt financial balances.
- Inbound webhooks must continue to be acknowledged and queued in MongoDB.
- Finance and sales operations must see a clear, unambiguous status in the Integration Dashboard:
  - Integration Status indicator turns Amber/Red: `RATE_LIMIT_EXHAUSTED`.
  - The banner displays the exact reset window: "Zoho Daily API Limit reached (0 requests remaining). Queue paused until reset at 00:00 UTC."
  - Individual deals display `syncStatus: "PAUSED_RATE_LIMIT"`.
- As soon as the reset window opens at midnight UTC, the queue automatically resumes processing without human intervention.

### 2. Backend Workflow
1. An outbound request to Zoho Books returns `HTTP 429 Too Many Requests` or code `14: "Rate limit exceeded"`.
2. The `zohoClient` interceptor parses the `Retry-After` header or calculates the duration until 00:00 UTC.
3. The in-memory `TokenBucketRateLimiter` calls `pause(durationMs)`.
4. Subsequent calls in the queue immediately defer without consuming network attempts.
5. Inbound webhooks continue to be saved with `status: "RECEIVED"`.
6. The `DashboardService` surfaces the rate-limit condition via `GET /api/dashboard/summary`.
7. When the rate-limiter timer unpauses at 00:00 UTC, the durable queue drains pending events.

### 3. Relevant Database Records
- **`WebhookEvent`**: Status remains `RECEIVED` with incremented backoff timer.
- **`IntegrationSync`**: Deals remain in their current valid state; no corrupted half-states.
- **`IntegrationLog`**: Log records `HTTP 429 Rate Limit Exceeded`.

### 4. API Interactions
- Outbound API calls to Zoho are paused.
- Inbound webhooks continue to return `HTTP 202 Accepted`.

### 5. Idempotency & Recovery Behavior
- When calls resume, deterministic reference keys ensure that any previously interrupted request resumes seamlessly without duplicate creations.

### 6. Relevant Tests
- `tests/phase1_schemas.test.js` (Rate limiting engine and 429 pause test)
- `tests/phase5_dashboard.test.js` (Exception aggregation and queue statistics)


# Integration Sequence Diagrams

This document contains Mermaid sequence diagrams illustrating end-to-end integration workflows, idempotency verification, and crash recovery procedures.

---

## 1. Closed Won to Customer, Sales Order, and M1 Invoice

This flow executes when a deal in HubSpot transitions to `Closed Won`. It creates or maps the customer, creates and confirms a Sales Order, and issues the Milestone 1 invoice (50% on signing).

```mermaid
sequenceDiagram
    autonumber
    participant Rep as Sales Representative
    participant HS as HubSpot CRM
    participant WH as Webhook Ingestion (/api/webhooks/hubspot)
    participant DB as MongoDB (WebhookEvent / IntegrationSync)
    participant Worker as Durable Queue Worker
    participant Cust as CustomerService
    participant SO as SalesOrderService
    participant Inv as InvoiceService
    participant Orch as OrchestrationService
    participant ZB as Zoho Books API

    Rep->>HS: Moves Deal to "Closed Won"
    HS->>WH: POST /api/webhooks/hubspot (deal.propertyChange)
    WH->>DB: Upsert WebhookEvent (status: RECEIVED)
    WH-->>HS: HTTP 202 Accepted (< 50ms)

    Note over Worker: Asynchronous Queue Worker picks event
    Worker->>DB: Atomically claim event lease (status: PROCESSING)
    Worker->>Orch: orchestrateClosedWon(dealId)
    
    Orch->>HS: GET /crm/v3/objects/deals/{dealId}?associations=companies,contacts
    HS-->>Orch: Return deal details (subtotal: 120,000, tax: 6,000, total: 126,000 AED)

    Orch->>Cust: resolveCustomer(companyId, contactId)
    alt Exactly 1 match found in Zoho
        Cust->>ZB: GET /books/v3/contacts?company_name=...
        ZB-->>Cust: Return existing customer (ID: zc_001)
        Cust->>DB: Upsert CustomerMapping (status: ACTIVE)
    else 0 matches found
        Cust->>ZB: POST /books/v3/contacts (companyName, email)
        ZB-->>Cust: Return newly created customer (ID: zc_new)
        Cust->>DB: Save CustomerMapping (AUTO_CREATED, status: ACTIVE)
    else Multiple matches (>1)
        Cust->>DB: Save CustomerMapping (status: AMBIGUOUS, candidates)
        Cust-->>Orch: HALT: REQUIRES_MANUAL_MATCH (Route to Dashboard)
    end

    Orch->>SO: getOrCreateSalesOrder(dealId, customerId)
    SO->>DB: Check local IntegrationSync.zohoSalesOrderId
    opt Not found locally (Pre-flight check)
        SO->>ZB: GET /books/v3/salesorders?reference_number=CRM_{dealId}
        alt Already exists in Zoho
            ZB-->>SO: Return existing SO (ID: so_001)
        else Does not exist
            SO->>ZB: POST /books/v3/salesorders (line_items, reference=CRM_{dealId})
            ZB-->>SO: Return draft SO (ID: so_001, item_id: item_001)
            SO->>ZB: POST /books/v3/salesorders/{so_001}/status/confirmed
            ZB-->>SO: Confirmed HTTP 200
        end
        SO->>DB: Update IntegrationSync (zohoSalesOrderId: so_001, lineItemId: item_001)
    end

    Orch->>Inv: createMilestoneInvoice(dealId, milestoneIndex=1)
    Inv->>DB: Check MilestoneInvoice (dealId + index=1)
    opt Not created locally
        Inv->>ZB: GET /books/v3/invoices?reference_number=CRM_{dealId}_M1
        alt Invoice found in Zoho (Adopt remote)
            ZB-->>Inv: Return existing invoice (ID: inv_m1)
        else Not found in Zoho
            Inv->>ZB: POST /books/v3/invoices (salesorder_id, salesorder_item_id, qty=0.5, rate=60000, tax=3000)
            ZB-->>Inv: Return created invoice (ID: inv_m1, total: 63,000 AED)
            Inv->>ZB: POST /books/v3/invoices/{inv_m1}/status/sent
            ZB-->>Inv: Marked sent HTTP 200
        end
        Inv->>DB: Save MilestoneInvoice (status: SENT, subtotal: 60,000, tax: 3,000, total: 63,000)
    end

    Orch->>Orch: Recalculate financial metrics (Invoiced: 63k, Unpaid: 63k, Not Invoiced: 63k, % Invoiced: 50%)
    Orch->>HS: PATCH /crm/v3/objects/deals/{dealId} (zoho_total_invoiced: 63000, zoho_sales_order_id: so_001, ...)
    HS-->>Orch: HTTP 200 Updated
    Worker->>DB: Update WebhookEvent (status: PROCESSED)
```

---

## 2. Go-Live Event Triggering Milestone 2 (30% at Go-Live)

Milestone 2 is **strictly forbidden on Closed Won**. It is triggered only by a genuine, verified go-live event.

```mermaid
sequenceDiagram
    autonumber
    participant Operator as Operator / CRM Webhook
    participant Gateway as Integration Gateway
    participant DB as MongoDB
    participant Inv as InvoiceService
    participant Orch as OrchestrationService
    participant ZB as Zoho Books API
    participant HS as HubSpot CRM

    Operator->>Gateway: POST /api/webhooks/hubspot (confirmed_go_live_date: 2026-10-15)
    Gateway->>DB: Upsert WebhookEvent & claim queue task

    Gateway->>Orch: processGoLiveEvent(dealId, confirmedGoLiveDate)
    Orch->>DB: Verify Prerequisites:
    Note over Orch: 1. Sales Order CONFIRMED?<br/>2. CustomerMapping ACTIVE?<br/>3. M1 Invoice SENT or PAID?<br/>4. Date valid ISO-8601 string?
    
    alt Prerequisites Valid
        Orch->>DB: Store confirmedGoLiveDate, goLiveVerifiedAt, m3EligibleAt (date + 90 days)
        Orch->>Inv: createMilestoneInvoice(dealId, milestoneIndex=2)
        Inv->>ZB: POST /books/v3/invoices (salesorder_id, salesorder_item_id, qty=0.3, rate=36000, tax=1800)
        ZB-->>Inv: Return created invoice (ID: inv_m2, total: 37,800 AED)
        Inv->>ZB: POST /books/v3/invoices/{inv_m2}/status/sent
        ZB-->>Inv: Marked sent
        Inv->>DB: Save MilestoneInvoice (status: SENT, total: 37,800 AED)

        Orch->>Orch: Recalculate Metrics (Total Invoiced: 100,800 AED = 80%, Not Invoiced: 25,200 AED = 20%)
        Orch->>HS: PATCH /crm/v3/objects/deals/{dealId} (zoho_total_invoiced: 100800, zoho_percentage_invoiced: 80.00)
        HS-->>Orch: Updated HTTP 200
    else Prerequisites Failed
        Orch->>DB: Reject trigger, update failureReason, transition to FAILED
    end
```

---

## 3. 90-Day Post Go-Live Triggering Milestone 3 (20% at 90 Days)

Milestone 3 is permitted only when **confirmedGoLiveDate + 90 days** has elapsed.

```mermaid
sequenceDiagram
    autonumber
    participant Cron as 90-Day Eligibility Poller / Webhook
    participant Gateway as Integration Gateway
    participant DB as MongoDB
    participant Inv as InvoiceService
    participant Orch as OrchestrationService
    participant ZB as Zoho Books API
    participant HS as HubSpot CRM

    Cron->>Gateway: Trigger M3 verification for dealId
    Gateway->>DB: Fetch IntegrationSync & MilestoneInvoice (M1 & M2)
    
    Gateway->>Gateway: Verify M3 Eligibility Guard:
    Note over Gateway: 1. Has M2 invoice been created?<br/>2. Is now >= confirmedGoLiveDate + 90 days?<br/>3. Is M3 already triggered?

    alt Date >= 90 Days post Go-Live
        Gateway->>Inv: createMilestoneInvoice(dealId, milestoneIndex=3)
        Inv->>ZB: POST /books/v3/invoices (salesorder_id, salesorder_item_id, qty=0.2, rate=24000, tax=1200)
        ZB-->>Inv: Return created invoice (ID: inv_m3, total: 25,200 AED)
        Inv->>ZB: POST /books/v3/invoices/{inv_m3}/status/sent
        ZB-->>Inv: Marked sent
        Inv->>DB: Save MilestoneInvoice (status: SENT, total: 25,200 AED)

        Gateway->>Orch: Recalculate Metrics (Total Invoiced: 126,000 AED = 100%, Not Invoiced: 0 AED = 0%)
        Orch->>HS: PATCH /crm/v3/objects/deals/{dealId} (zoho_total_invoiced: 126000, zoho_percentage_invoiced: 100.00)
        HS-->>Orch: Updated HTTP 200
        Gateway->>DB: Mark IntegrationSync status: SYNCED
    else Date < 90 Days
        Gateway-->>Cron: Abort: ELIGIBILITY_GUARD_FAILED (90 days not reached)
    end
```

---

## 4. Zoho Customer Payment Reverse Sync & Refund Flow

When a finance operator records a payment, partial payment, reversal, or refund in Zoho Books, the integration captures the event and reflects the new financial balance in HubSpot.

```mermaid
sequenceDiagram
    autonumber
    participant Finance as Finance Operator
    participant ZB as Zoho Books
    participant WH as Webhook Route (/api/webhooks/zoho)
    participant PaySvc as PaymentService
    participant DB as MongoDB (PaymentRecord, MilestoneInvoice, IntegrationSync)
    participant HS as HubSpot CRM

    Finance->>ZB: Records payment of 63,000 AED against M1 invoice
    ZB->>WH: POST /api/webhooks/zoho (Header: X-Zoho-Webhook-Token, payload: customerpayment)
    WH->>WH: Validate HMAC / Webhook Secret Token
    WH-->>ZB: HTTP 202 Accepted

    WH->>PaySvc: processPaymentEvent(paymentPayload)
    PaySvc->>ZB: GET /books/v3/customerpayments/{payment_id}
    ZB-->>PaySvc: Return verified payment record (verified against Zoho Books API)

    PaySvc->>DB: Find MilestoneInvoice by zohoInvoiceId
    PaySvc->>DB: Upsert PaymentRecord (amount: 63,000, amountMinor: 6300000, status: APPLIED)
    PaySvc->>DB: Update MilestoneInvoice balance (63,000 - 63,000 = 0 AED, status: PAID)

    PaySvc->>PaySvc: Recalculate Financial Metrics:
    Note over PaySvc: Total Collected += 63,000 AED<br/>Invoiced Unpaid -= 63,000 AED<br/>% Collected = (63,000 / 126,000) * 100 = 50.00%<br/>Recompute isOverdue & nextDueDate

    PaySvc->>HS: PATCH /crm/v3/objects/deals/{dealId} (zoho_total_collected: 63000, zoho_invoiced_unpaid: 0, zoho_percentage_collected: 50.00)
    HS-->>PaySvc: HTTP 200 Updated
    PaySvc->>DB: Mark PaymentRecord hubspotSynced: true
```

---

## 5. Network Drop Crash Recovery & Pre-Flight Reconciliation

This sequence demonstrates what occurs when an HTTP timeout or network drop occurs during a remote invoice creation POST.

```mermaid
sequenceDiagram
    autonumber
    participant Worker as Integration Worker
    participant ZB as Zoho Books API
    participant DB as MongoDB
    participant Dashboard as Operator Dashboard

    Worker->>ZB: POST /books/v3/invoices (reference_number: CRM_deal_001_M1)
    Note over ZB: Zoho Books creates invoice inv_999 successfully...
    Note over Worker,ZB: ...BUT network drops before response reaches Worker! (ETIMEDOUT / 504)

    Worker->>Worker: Catch ETIMEDOUT exception
    Note over Worker: NEVER blindly repeat the POST!
    Worker->>ZB: GET /books/v3/invoices?reference_number=CRM_deal_001_M1 (Pre-flight Reconciliation)

    alt Invoice found in Zoho Books!
        ZB-->>Worker: Return Invoice (ID: inv_999, total: 63,000)
        Worker->>DB: Adopt remote ID & save MilestoneInvoice (zohoInvoiceId: inv_999, status: SENT)
        Worker->>DB: Log RECOVERED_AFTER_CRASH in IntegrationLog
        Worker->>Worker: Resume normal workflow cleanly without duplicate
    else Zoho search returns empty (Record was not created)
        ZB-->>Worker: Return empty array
        Worker->>DB: Transition IntegrationSync to RECONCILIATION_REQUIRED
        Worker->>DB: Block subsequent automatic attempts
        Worker->>Dashboard: Surface Alert in Operator Action Center
        Note over Dashboard: Operator confirms state and clicks "Retry Sync"
    end
```


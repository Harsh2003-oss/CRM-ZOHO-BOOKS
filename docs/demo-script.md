# 3–5 Minute Evaluation Demo Script

This script provides a concise, step-by-step walkthrough for evaluating the Complyance CRM & Zoho Books Integration Gateway during a live demonstration or recorded video submission.

---

## Part 1: Architecture & Topology Overview (0:00 – 0:45)

1. **Introduction**:
   - Welcome the reviewer. State the purpose: An enterprise bi-directional integration linking HubSpot CRM with Zoho Books for multi-milestone contract invoicing and collections tracking.
2. **Architecture Highlights**:
   - **Frontend**: Modular React 18 + Vite SPA styled with Tailwind CSS, served directly by Express at `/dashboard/`.
   - **Backend API Gateway**: Node.js / Express 5 with durable FIFO queue, distributed atomic lease locking, and token-bucket rate limiting.
   - **Persistence**: MongoDB for webhook deduplication, customer mappings, sequential milestone invoices, and payment audits.
   - **Reliability Pattern**: Pre-Flight Deterministic Reconciliation (`CRM_{dealId}_M{index}`) preventing duplicate creations during network drops.

---

## Part 2: HubSpot Closed Won & Milestone 1 Invoicing (0:45 – 1:30)

1. **Triggering the Event**:
   - Open HubSpot Deal: e.g., "Falcon HyperTech Enterprise Implementation" (AED 120,000 subtotal, 5% VAT, AED 126,000 gross).
   - Move Deal stage to **Closed Won**.
2. **Non-blocking Ingestion**:
   - Show the webhook ingestion response: returns `HTTP 202 Accepted` in `< 50ms`. The CRM UI never waits on Zoho Books.
3. **Automated Workflow**:
   - **Customer Matching**: Matches existing customer or auto-creates one.
   - **Sales Order**: Creates draft SO in Zoho Books and marks it `confirmed`.
   - **Milestone 1**: Automatically raises M1 Invoice (50% on signing = AED 60,000 subtotal + AED 3,000 VAT = AED 63,000 gross) linked to the Sales Order line item (`quantity: 0.5`).
   - **HubSpot Deal Update**: Shows deal updated with `zoho_sales_order_id`, `zoho_total_invoiced: 63,000`, `zoho_invoiced_unpaid: 63,000`, and `zoho_percentage_invoiced: 50.00%`.

---

## Part 3: Sequential Milestone Progression (M2 & M3) (1:30 – 2:30)

1. **Milestone 2 (30% at Go-Live)**:
   - Explain the core business rule: **M2 is strictly forbidden on Closed Won**.
   - Set the deal's `confirmed_go_live_date` in HubSpot.
   - Show the integration verifying prerequisites (confirmed SO, active customer, M1 issued).
   - The integration generates M2 Invoice (AED 36,000 subtotal + AED 1,800 VAT = AED 37,800 gross, `quantity: 0.3`).
   - HubSpot deal updates: `zoho_total_invoiced: 100,800` (80.00%), `zoho_not_invoiced: 25,200` (20.00%).
2. **Milestone 3 (20% at 90 Days post Go-Live)**:
   - Demonstrate the 90-day time guard: Attempting M3 before 90 days fails validation.
   - When 90 days elapsed: M3 Invoice is raised (AED 24,000 subtotal + AED 1,200 VAT = AED 25,200 gross, `quantity: 0.2`).
   - Total Invoiced reaches exactly AED 126,000 (100.00%), and Amount Not Invoiced reaches AED 0.

---

## Part 4: Payment Reverse Sync & Collections Dashboard (2:30 – 3:45)

1. **Payment Webhook & Integer Minor-Unit Math**:
   - Record a payment of AED 63,000 against M1 in Zoho Books.
   - The webhook arrives at `/api/webhooks/zoho`.
   - The integration verifies the payment details with Zoho Books and records `PaymentRecord` using integer minor units (fils: `6,300,000`).
   - HubSpot updates: `zoho_total_collected: 63,000`, `zoho_percentage_collected: 50.00%`, `zoho_invoiced_unpaid: 37,800`.
2. **Dashboard Overview (`/dashboard/`)**:
   - **KPI Cards**: Total Invoiced, Collected, Outstanding, and Overdue separated cleanly by currency.
   - **Collections & Aging Table**: Show customers broken down by aging buckets (`Current`, `1–30`, `31–60`, `61–90`, `90+ days`), with oldest unpaid invoice badges and direct payment sync triggers.
   - **Audit Logs Page**: Show sanitized request/response logs with sensitive tokens and passwords redacted.

---

## Part 5: Operator Action Center & Error Resilience (3:45 – 4:30)

1. **Ambiguous Customer Disambiguation**:
   - Navigate to Operator Tab.
   - Show an ambiguous customer match ("Sharjah Maritime Services" with 2 candidate accounts).
   - Select the intended Zoho account using the candidate radio selector and click "Resolve Match".
   - Mapping transitions to `ACTIVE`, and the deal resumes processing immediately.
2. **Reconciliation & Crash Recovery**:
   - Show a deal in `RECONCILIATION_REQUIRED` caused by a network timeout during remote invoice creation.
   - Demonstrate the operator 1-click retry: The system re-checks Zoho by reference `CRM_{dealId}_M1` and safely adopts the invoice without duplicating records.

---

## Part 6: Automated Test Suite & Wrap-Up (4:30 – 5:00)

1. **Run Full Test Suite**:
   ```bash
   npm test
   ```
   - Show all 153 tests passing across 11 test suites with 0 failures in ~21 seconds.
2. **Note on Account Limitations**:
   - Clarify the external account fact: The active Zoho Books account is provisioned in the India datacenter (`in`), which supports INR/AED currency but restricts UAE VAT tax agency setup. All calculations and formulas adhere strictly to the UAE 5% VAT specification in verified automated tests and demo datasets.
3. **Closing**:
   - Conclude demo.


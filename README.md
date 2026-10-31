# Complyance Take-Home: CRM & Zoho Books Integration Gateway

An enterprise-grade, bi-directional integration gateway connecting **HubSpot CRM** and **Zoho Books**. The system automates the transition from Closed Won CRM deals into confirmed Sales Orders, orchestrates multi-milestone progressive invoicing (50% on signing, 30% at go-live, 20% at 90 days), and synchronizes real-time payment collections back to CRM financial metrics.

Includes an operational monitoring dashboard built with **React 18 + Vite + Tailwind CSS** featuring collections aging, real-time audit logging, and an operator exception resolution center.

---

## Table of Contents
1. [Business Problem & Solution Overview](#business-problem--solution-overview)
2. [Architecture & Technology Stack](#architecture--technology-stack)
3. [Architecture Diagram](#architecture-diagram)
4. [Completed Phases & Key Capabilities](#completed-phases--key-capabilities)
5. [Prerequisites & Environment Configuration](#prerequisites--environment-configuration)
6. [OAuth Setup Guides (HubSpot & Zoho Books)](#oauth-setup-guides-hubspot--zoho-books)
7. [Installation & Execution Guide](#installation--execution-guide)
8. [Loading Demo Dataset](#loading-demo-dataset)
9. [Automated Testing Suite](#automated-testing-suite)
10. [Dashboard & API Documentation](#dashboard--api-documentation)
11. [Idempotency & Crash Recovery Strategy](#idempotency--crash-recovery-strategy)
12. [Security & Sanitization](#security--sanitization)
13. [External Account Facts & Known Limitations](#external-account-facts--known-limitations)
14. [Submission Documentation Index](#submission-documentation-index)

---

## Business Problem & Solution Overview

### The Problem
- **Sales Teams** operate inside HubSpot CRM and require immediate visibility into deal billing status, payment realization, and overdue receivables.
- **Finance Teams** work inside Zoho Books and require legally binding Sales Orders, strict milestone-based tax invoices, and verified payment allocations.
- Without deep bi-directional synchronization, teams suffer from manual double-entry, duplicate invoice creation caused by network drops, out-of-order webhook delivery, and mismatched financial reporting.

### The Solution
A decoupled, asynchronous integration gateway providing:
- **Instant CRM Acknowledgement**: Webhooks acknowledge HubSpot and Zoho Books within < 50ms (HTTP 202) while durable background workers process domain operations.
- **Sequential Milestone Lifecycle**: Enforces M1 (50% on signing), M2 (30% at verified go-live), and M3 (20% at 90-days post go-live) linked to the confirmed Sales Order item.
- **Reverse Payment Sync**: Synchronizes full payments, partial payments, reversals, and refunds with integer minor-unit arithmetic.
- **Pre-Flight Deterministic Reconciliation**: Prevents duplicate records by querying deterministic reference numbers (`CRM_{dealId}_M{index}`) before retrying uncertain network calls.
- **Operator Action Center**: Human-in-the-loop exception resolution for ambiguous customer mappings and remote sync recoveries.

---

## Architecture & Technology Stack

| Layer | Technologies | Key Highlights |
| :--- | :--- | :--- |
| **Frontend** | React 18.3.1, Vite 5.4.11, Tailwind CSS 3.4.17 | Single-page application, zero external CDNs, tabbed routing, modal dialogs |
| **Backend Gateway** | Node.js (v24), Express 5.2.1 | Non-blocking async webhook ingestion, regex static asset serving |
| **Persistence** | MongoDB, Mongoose 9.0 | Unique partial indexes, compound constraints, atomic lease locking |
| **Queue & Workers** | MongoDB Durable FIFO Queue | Distributed lease timeouts, fencing tokens, exponential jittered backoff |
| **Integrations** | HubSpot CRM API v3, Zoho Books API v3 | Multi-region OAuth auto-refresher (5-min pre-expiry), Token Bucket limiter |
| **Testing** | Node.js Native Test Runner (`node:test`), Supertest | 203 tests across 14 suites with in-memory MongoDB |

---

## Architecture Diagram

```mermaid
flowchart TB
    subgraph ClientTier ["Frontend & Presentation Tier (client/)"]
        UI["React 18 + Vite SPA<br/>(Tailwind CSS)"]
        OV["Financial Overview & KPI Cards"]
        COL["Collections & Aging Table<br/>(Current, 1-30, 31-60, 61-90, 90+)"]
        LOGS["Sanitized Audit Log Inspector"]
        OP["Operator Action Center<br/>(Disambiguation & Retry)"]
        UI --> OV
        UI --> COL
        UI --> LOGS
        UI --> OP
    end

    subgraph GatewayTier ["Backend API Gateway & Orchestration (server/)"]
        EXP["Express 5 Server (Port 5000)"]
        PROXY["Vite Dev Proxy / Express Static (/dashboard)"]
        AUTH_MW["Operator API Key Middleware (x-operator-key)"]
        
        WH_INGEST["Webhook Ingestion (POST /api/webhooks/hubspot & /zoho)"]
        QUEUE["Durable FIFO Queue (Atomic Lease & Fencing Tokens)"]
        
        ORCH["Orchestration Engine (orchestrationService.js)"]
        CUST_SVC["Customer Matching Service (Exact, Auto, Ambiguous)"]
        SO_SVC["Sales Order Service (Draft, Confirm, Line Item)"]
        INV_SVC["Milestone Invoicing Service (M1: 50%, M2: 30%, M3: 20%)"]
        PAY_SVC["Payment & Refund Service (Integer Cents, Reversals)"]
        DASH_SVC["Dashboard & Collections Service (5 Aging Buckets)"]
        
        TOKEN_MGR["Zoho OAuth Token Manager (Pre-expiry Auto-refresh)"]
        RATE_LIMITER["Token Bucket Rate Limiter (100 req/min Zoho)"]
        RECON["Deterministic Pre-Flight Reconciler (CRM_{dealId}_M{index})"]

        EXP --> PROXY
        PROXY --> UI
        EXP --> AUTH_MW
        EXP --> WH_INGEST
        WH_INGEST --> QUEUE
        QUEUE --> ORCH
        
        ORCH --> CUST_SVC
        ORCH --> SO_SVC
        ORCH --> INV_SVC
        ORCH --> PAY_SVC
        EXP --> DASH_SVC
        
        INV_SVC --> RECON
        ORCH --> TOKEN_MGR
        ORCH --> RATE_LIMITER
    end

    subgraph DataTier ["Persistence Tier (MongoDB)"]
        DB[(MongoDB Database)]
        M_EVENT["WebhookEvent"]
        M_SYNC["IntegrationSync"]
        M_INV["MilestoneInvoice"]
        M_CUST["CustomerMapping"]
        M_PAY["PaymentRecord"]
        M_LOG["IntegrationLog"]
        
        DB --- M_EVENT
        DB --- M_SYNC
        DB --- M_INV
        DB --- M_CUST
        DB --- M_PAY
        DB --- M_LOG
    end

    subgraph ExternalServices ["External Cloud Services"]
        HS["HubSpot CRM API (OAuth / Private App Key)"]
        ZB["Zoho Books API v3 (OAuth 2.0 Multi-region)"]
        HS_WH["HubSpot Deal Webhooks"]
        ZB_WH["Zoho Books Payment Webhooks"]
    end

    HS_WH -->|Inbound Webhook HTTP 202| WH_INGEST
    ZB_WH -->|Inbound Webhook HTTP 202| WH_INGEST
    
    CUST_SVC <-->|REST API| ZB
    SO_SVC <-->|REST API| ZB
    INV_SVC <-->|REST API| ZB
    PAY_SVC <-->|REST API| ZB
    
    ORCH <-->|REST API (Push Properties)| HS
    ORCH <--> DB
    DASH_SVC <--> DB
    QUEUE <--> DB
```

---

## Completed Phases & Key Capabilities

- **Phase 1: Foundation & Resilient Infrastructure**
  - Mongoose models with compound indexes and unique constraints preventing duplicate states.
  - Proactive multi-region Zoho OAuth refresher with concurrency mutex locking.
  - Token-bucket rate limiter enforcing Zoho (100/min) and HubSpot (100/10s) rate limits.
  - Deep `/api/health` check verifying live external connectivity.
- **Phase 2: Webhook Ingestion & Durable Queue**
  - High-throughput webhook reception (`< 50ms`, HTTP 202).
  - Durable FIFO queue with distributed atomic lease expiration and crash recovery.
- **Phase 3: CRM to Zoho Books (Sales Orders & Milestone Invoicing)**
  - Rule-based customer matching (`AUTOMATIC_EXACT`, `AUTO_CREATED`, `AMBIGUOUS`).
  - Draft Sales Order creation, tax calculation, and confirmation.
  - Milestone 1 (50% on signing) raised against confirmed Sales Order line item.
  - Milestone 2 (30% at verified go-live) and Milestone 3 (20% at 90 days post go-live) lifecycle enforcement.
  - HubSpot deal property updates (`zoho_sales_order_id`, `zoho_total_invoiced`, `zoho_is_overdue`).
- **Phase 4: Zoho Books to CRM Reverse Sync (Payments & Refunds)**
  - Payment event ingestion, partial payment allocation, and multi-invoice payment distribution.
  - Support for payment reversals and credit refunds with integer minor-unit balance updates.
- **Phase 5: Operational Dashboard & React + Vite Architecture**
  - Real-time financial metrics: Invoiced, Collected, Invoiced Unpaid, and Not-Yet-Invoiced.
  - Accounts Receivable Aging Table (Current, 1–30, 31–60, 61–90, 90+ days).
  - Operator Action Center: Disambiguate customer matches, re-queue failed webhooks, and retry sync.
- **Phase 6: Seed Dataset & Comprehensive Submission Deliverables**
  - Idempotent seed script with 16 customers and 23 deals covering all realistic financial states.
  - Complete architectural, sequence, field-mapping, deployment, and scenario documentation.

---

## Prerequisites & Environment Configuration

### Prerequisites
- **Node.js**: v18.x, v20.x, or v24.x
- **npm**: v9.x or v11.x
- **MongoDB**: Local MongoDB instance (port 27017) or MongoDB Atlas cluster.

### Environment Variables
Copy `.env.example` to `.env` in the root directory:

```bash
cp .env.example .env
```

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | API Server listening port | `5000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/crm_zoho_dev` |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App Access Token | `pat-na1-...` |
| `ZOHO_CLIENT_ID` | Zoho API Client ID | `1000.XXXX...` |
| `ZOHO_CLIENT_SECRET` | Zoho API Client Secret | `yyyy...` |
| `ZOHO_REFRESH_TOKEN` | Permanent Zoho OAuth Refresh Token | `1000.zzzz...` |
| `ZOHO_ORG_ID` | Zoho Books Organization ID | `60093852869` |
| `ZOHO_REGION` | Zoho regional domain (`in`, `com`, `eu`) | `in` |
| `ZOHO_WEBHOOK_SECRET` | Secret token verifying Zoho webhooks | `your_zoho_webhook_token_secret` |
| `OPERATOR_API_KEY` | Header/bearer key for Operator Actions | `your_secure_operator_api_key` |
| `DEFAULT_CURRENCY` | Default Sales Order currency | `AED` |
| `VAT_PERCENTAGE` | Configurable VAT percentage (`0` disables VAT line items; `5.0` default if unset) | `0` |
| `ZOHO_UAE_VAT_TAX_ID` | Zoho Books tax entity ID for line item VAT (optional) | `your_vat_tax_id_here` |

> [!IMPORTANT]
> **Operator Authentication Security**:
> In production (`NODE_ENV=production`), the Operator Action Center fails closed (HTTP 503) if `OPERATOR_API_KEY` is missing, empty, or set to an insecure default. An explicit dev key is permitted only in local development/testing (`NODE_ENV !== 'production'`). Never commit or hardcode production operator keys.

---

## OAuth Setup Guides (HubSpot & Zoho Books)

### HubSpot Private App Setup
1. In HubSpot, navigate to **Settings → Integrations → Private Apps**.
2. Create a Private App named "Zoho Books Integration Gateway".
3. Under **Scopes**, grant:
   - `crm.objects.deals.read`, `crm.objects.deals.write`
   - `crm.objects.companies.read`, `crm.objects.contacts.read`
   - `crm.schemas.deals.read`, `crm.schemas.deals.write`
4. Copy the generated Access Token to `HUBSPOT_ACCESS_TOKEN` in your `.env`.
5. Run the property provisioning script to provision the 12 required custom fields:
   ```bash
   npm run setup:hubspot
   ```

### Zoho Books OAuth Setup
1. Open the [Zoho API Console](https://api-console.zoho.in) (or `.com` based on your region).
2. Create a **Server-based Application**:
   - Authorized Redirect URI: `https://localhost:5000/oauth/callback`
3. Generate a grant code with scope: `ZohoBooks.fullaccess.all`.
4. Exchange the grant code for a permanent refresh token:
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d "code={grant_code}&client_id={client_id}&client_secret={client_secret}&grant_type=authorization_code"
   ```
5. Place the resulting `refresh_token`, `client_id`, `client_secret`, and `org_id` into `.env`.

---

## Installation & Execution Guide

### 1. Install Dependencies
```bash
npm install
npm install --prefix client
```

### 2. Development Mode (Hot-Reloading)
Run both the Express backend API and Vite React frontend concurrently:
```bash
npm run dev
```
- **Express Backend**: `http://localhost:5000`
- **Vite React Dev Server**: `http://localhost:5173/dashboard/`

### 3. Production Build & Execution
Build the optimized React frontend and serve it statically through Express:
```bash
npm run build
npm start
```
- Open `http://localhost:5000/dashboard/` in your browser.

---

## Loading Demo Dataset

To populate your database with a complete, idempotent demonstration dataset covering 16 customers and 23 deals across all financial states:

```bash
npm run seed
```

This seeds:
- 16 Customer Mappings (Active exact, auto-created, and ambiguous).
- 23 CRM Deals and confirmed Sales Orders.
- 33 Milestone Invoices (M1, M2, M3, voided, and overdue).
- 23 Verified Payment Records with minor-unit accuracy.
- Queued, processed, and failed webhook events.
- Redacted audit log entries.

*Note: Safe to re-run multiple times without duplicate record creation.*

---

## Automated Testing Suite

The project includes 203 comprehensive tests across 14 suites executed via Node.js native test runner and `mongodb-memory-server` without touching production databases or credentials:

```bash
npm test
```

### Test Suite Breakdown
| Suite File | Scope | Test Count |
| :--- | :--- | :---: |
| `tests/phase1.test.js` | Schema Constraints, OAuth Mutex, Rate Limiter, Health Check | 10 |
| `tests/phase2_step1_webhook.test.js` | Webhook ingestion (<50ms), queue locking, deduplication, Signature v3 | 23 |
| `tests/phase3_customerMatching.test.js` | Customer matching rules (exact, auto-create, ambiguous) | 10 |
| `tests/phase3_invoice.test.js` | Sales Order linkage, M1 calculation, timeout reconciliation | 30 |
| `tests/phase3_orchestration.test.js` | End-to-end HubSpot sync, string property casting, UTC date logic | 30 |
| `tests/phase3_salesOrder.test.js` | Sales Order draft, confirmation, lease locks, crash recovery | 24 |
| `tests/phase3_step5_milestones.test.js` | M2 Go-Live, M3 90-Day time guard, sequential enforcement | 12 |
| `tests/phase4_payments.test.js` | Payments, partial payments, reversals, refunds, minor units | 31 |
| `tests/phase5_dashboard.test.js` | KPI calculation, 5 aging buckets, operator auth, Vite bundle | 16 |
| `tests/phase6_seed.test.js` | Seed dataset verification, idempotency, production safeguard | 4 |
| `tests/worker.test.js` | Dedicated Queue Worker, lease locking, fencing tokens, backoff | 13 |
| **TOTAL VERIFIED TESTS** | **14 Test Suites Across 11 Test Files** | **203 Passed (0 Failed)** |

---

## Dashboard & API Documentation

### Dashboard Route
- **URL**: `http://localhost:5000/dashboard/`
- **Features**:
  - **Overview Tab**: Live KPI cards for Total Invoiced, Collected, Unpaid, and Not-Yet-Invoiced. Cash realization fulfillment bar.
  - **Collections Tab**: AR Aging buckets (`Current`, `1–30`, `31–60`, `61–90`, `90+ days`), customer search, oldest unpaid invoice badges, and 1-click payment sync.
  - **Logs Tab**: Queue telemetry counters, filterable audit log with payload modal inspector.
  - **Operator Tab**: Ambiguous customer resolution picker, event retry, and reconciliation recovery.

### Key API Endpoints
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET` | `/api/health` | Deep connectivity health check | No |
| `POST` | `/api/webhooks/hubspot` | HubSpot deal change ingestion | No (< 50ms) |
| `POST` | `/api/webhooks/zoho` | Zoho Books payment/invoice ingestion | Yes (Token) |
| `GET` | `/api/dashboard/summary` | Aggregated financial metrics | No |
| `GET` | `/api/dashboard/collections` | Customer aging & unpaid balance table | No |
| `GET` | `/api/dashboard/logs` | Redacted integration audit log | No |
| `GET` | `/api/dashboard/exceptions` | Actionable operator exception items | No |
| `POST` | `/api/operator/resolve-customer`| Resolve ambiguous customer mapping | `x-operator-key` |
| `POST` | `/api/operator/retry-event/:id` | Re-queue failed webhook event | `x-operator-key` |
| `POST` | `/api/operator/retry-hubspot-sync/:dealId` | Force push financial metrics to HubSpot | `x-operator-key` |

---

## Idempotency & Crash Recovery Strategy

### The Pre-Flight Deterministic Reconciliation Pattern
If a network timeout occurs while creating a Sales Order or Invoice in Zoho Books:
1. The gateway **never blindly retries the POST**.
2. It executes a pre-flight `GET` by deterministic reference number:
   - Sales Order: `reference_number = "CRM_" + dealId`
   - Invoices: `reference_number = "CRM_" + dealId + "_M" + milestoneIndex`
3. If Zoho Books created the record before the timeout, the gateway adopts the remote ID, updates local state, and completes the workflow cleanly.
4. If the record is absent, it safely transitions to `RECONCILIATION_REQUIRED` for operator verification.

---

## Security & Sanitization

1. **Deterministic Redaction**:
   All request and response payloads passing through `IntegrationLog` are scrubbed of Authorization headers, API keys, passwords, and tokens via deterministic regex replacement (`server/src/utils/redact.js`).
2. **Operator Authorization**:
   Sensitive operational actions (manual match override, event re-queue) require a valid `x-operator-key` header.
3. **Fencing Tokens & Lease Expirations**:
   Workers maintain short-lived leases in MongoDB with fencing tokens, preventing split-brain execution across clustered servers.

---

## External Account Facts & Known Limitations

> [!WARNING]
> **Zoho Books Organization Edition & Tax Compliance Notice**
> 
> - **Tested Organization**: The live integration test was conducted against a Zoho Books India-edition organization (`in` / accounts.zoho.in, Org ID `60093852869`).
> - **Live Test Verification**: The live NovaTech Sales Order (`SO-00002`) and Milestone 1 invoice (`INV-000003`) were created with 0% VAT.
> - **UAE 5% VAT & FTA Status**: UAE 5% VAT invoice creation and UAE Federal Tax Authority (FTA) compliance have **not** been verified in a UAE-edition Zoho Books organization.
> - **Tax Calculation Support vs. Compliance**: The codebase natively supports configurable tax calculations, integer-cent rounding, and tax ID resolution (controlled via the verified `VAT_PERCENTAGE` environment variable, with fallback `TAX_PERCENTAGE` and `ZOHO_UAE_VAT_TAX_ID`). However, application-level tax calculation and configuration support do not themselves establish legal tax compliance.
> - **Production Deployment**: Actual tax application and invoice compliance depend on connecting to a Zoho Books UAE-edition organization with appropriate tax configuration and a valid business Tax Registration Number (TRN).

> [!NOTE]
> **Milestone 3 (90-Day Post Go-Live) Scheduling Architecture**
>
> - **Eligibility Calculation**: Milestone 3 eligibility is calculated deterministically as `confirmed_go_live_date` + 90 calendar days (`m3EligibleAt`). Any invocation before this exact timestamp strictly fails closed with `status: "M3_NOT_YET_ELIGIBLE"` and returns the exact number of remaining days.
> - **Evaluator Implementation**: The core M3 business logic and boundary evaluator are fully implemented in `OrchestrationService.process90DayMilestone` and verified with automated test suites.
> - **No Built-in Daily Scheduler**: There is currently no built-in daily background cron daemon running inside the server process. Milestone 3 evaluation must be triggered through an API/webhook or an external scheduler such as AWS EventBridge, Google Cloud Scheduler, or GitHub Actions scheduled workflows. Automatic background scheduling is not implemented in-process.

---

## Submission Documentation Index

Detailed documentation files in the [`docs/`](file:///d:/CRM_ZOHO_BOOKS/docs/) directory:

- [docs/architecture.md](file:///d:/CRM_ZOHO_BOOKS/docs/architecture.md): Complete architectural breakdown and Mermaid topology.
- [docs/sequences.md](file:///d:/CRM_ZOHO_BOOKS/docs/sequences.md): 5 Mermaid sequence diagrams covering Won deals, M2, M3, payment reverse sync, and crash recovery.
- [docs/field-mappings.md](file:///d:/CRM_ZOHO_BOOKS/docs/field-mappings.md): Property-by-property mapping tables, data types, ownership, and API call budgets (Requirement 13).
- [docs/scenarios.md](file:///d:/CRM_ZOHO_BOOKS/docs/scenarios.md): Comprehensive answers to all 7 core assignment scenarios.
- [docs/deployment.md](file:///d:/CRM_ZOHO_BOOKS/docs/deployment.md): Production cloud deployment guide (Atlas, OAuth, environment, Vite bundle).
- [docs/demo-script.md](file:///d:/CRM_ZOHO_BOOKS/docs/demo-script.md): Concise 3–5 minute live demonstration walkthrough script.


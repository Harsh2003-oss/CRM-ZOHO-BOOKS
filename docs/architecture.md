# Enterprise Architecture: CRM & Zoho Books Integration Gateway

This document details the high-level system architecture, service interactions, data tier, and security boundaries of the Complyance CRM & Zoho Books Direct Integration Gateway.

---

## 1. System Topology & Architecture Diagram

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
        EXP["Express 5 Server<br/>(Port 5000)"]
        PROXY["Vite Dev Proxy / Express Static (/dashboard)"]
        AUTH_MW["Operator API Key Middleware<br/>(Header: x-operator-key)"]
        
        WH_INGEST["Webhook Ingestion Route<br/>(POST /api/webhooks/hubspot & /zoho)"]
        QUEUE["Durable FIFO Queue Service<br/>(Atomic Lease & Fencing Tokens)"]
        
        ORCH["Orchestration Engine<br/>(orchestrationService.js)"]
        CUST_SVC["Customer Matching Service<br/>(Exact, Auto-create, Ambiguous)"]
        SO_SVC["Sales Order Service<br/>(Draft, Confirm, Line Item ID)"]
        INV_SVC["Milestone Invoicing Service<br/>(M1: 50%, M2: 30%, M3: 20%)"]
        PAY_SVC["Payment & Refund Service<br/>(Integer Cents, Reversals, Refunds)"]
        DASH_SVC["Dashboard & Collections Service<br/>(Aging, Unknown Balance Safeguard)"]
        
        TOKEN_MGR["Zoho OAuth Token Manager<br/>(Mutex Lock, Pre-expiry Auto-refresh)"]
        RATE_LIMITER["Token Bucket Rate Limiter<br/>(100 req/min Zoho, 100 req/10s HubSpot)"]
        RECON["Deterministic Pre-Flight Reconciler<br/>(CRM_{dealId}_M{index})"]

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

    subgraph DataTier ["Persistence Tier (MongoDB Mongoose)"]
        DB[(MongoDB Database)]
        M_EVENT["WebhookEvent<br/>(Deduplication & Queue)"]
        M_SYNC["IntegrationSync<br/>(Deal State & Leases)"]
        M_INV["MilestoneInvoice<br/>(Compound Index: dealId + milestone)"]
        M_CUST["CustomerMapping<br/>(Company/Contact Links)"]
        M_PAY["PaymentRecord<br/>(Audit, Reversals, Refunds)"]
        M_LOG["IntegrationLog<br/>(Redacted Payload Audit)"]
        
        DB --- M_EVENT
        DB --- M_SYNC
        DB --- M_INV
        DB --- M_CUST
        DB --- M_PAY
        DB --- M_LOG
    end

    subgraph ExternalServices ["External Cloud Ecosystems"]
        HS["HubSpot CRM API<br/>(OAuth / Private App Key)"]
        ZB["Zoho Books API v3<br/>(OAuth 2.0 Multi-region)"]
        
        HS_WH["HubSpot Deal Webhooks<br/>(dealstage: closedwon, milestone_stage)"]
        ZB_WH["Zoho Books Payment Webhooks<br/>(customerpayment, refund)"]
    end

    %% External Connections
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

## 2. Core Architectural Pillars

### 1. Ingestion Decoupling & Instant Acknowledgement
- **Non-blocking Webhooks**: All incoming webhook events (HubSpot `dealstage = closedwon`, `confirmed_go_live_date`, or Zoho `customerpayment.created`) are validated, written to the `WebhookEvent` collection, and acknowledged with **HTTP 202 Accepted in < 50ms**.
- **CRM Isolation**: Sales representatives in HubSpot never experience UI latency or blocking during deal closure.

### 2. Durable Queue with Distributed Lease Fencing
- The `QueueService` polls for pending webhook events using atomic MongoDB operations (`findOneAndUpdate` with lease expiration timestamps).
- Prevents split-brain worker concurrency and guarantees **at-least-once processing with exactly-once side effects**.

### 3. Idempotent Pre-Flight Reconciliation Pattern
- Network drops during remote record creation (`POST /invoices` or `POST /salesorders`) are handled through **deterministic reference numbers** (`CRM_{dealId}` and `CRM_{dealId}_M{index}`).
- Before retrying any uncertain remote POST, the integration performs a pre-flight query by reference number. If the record already exists in Zoho Books, the worker adopts the remote ID and aborts redundant creation.

### 4. Proactive Multi-Region OAuth Token Management
- Managed via `zohoClient.js`:
  - Enforces region-specific domains (`accounts.zoho.in` for India DC, `accounts.zoho.com` for US DC).
  - Maintains in-memory token cache with a **5-minute pre-expiration proactive refresh**.
  - Uses an async mutex lock to collapse concurrent refresh calls into a single in-flight promise, preventing invalid grant errors.

### 5. Integer Minor-Unit Arithmetic
- All currency balances, milestone splits, and payment applications maintain integer minor-unit arithmetic (fils/cents: `amount * 100`) to eliminate IEEE 754 floating-point rounding errors.

---

## 3. Security & Boundary Isolation

1. **Credential Sanitization**: The `IntegrationLog` audit pipeline strictly filters and masks authorization headers, OAuth refresh tokens, and customer secrets using deterministic regex redaction (`redact.js`).
2. **Operator Authorization**: Consequential operator actions (customer disambiguation, reconciliation retry, HubSpot property push) require the `x-operator-key` request header.
3. **No Financial Guesses**: If customer matching finds multiple matching Zoho contacts, execution halts, flags the record as `AMBIGUOUS`, and routes it to the human Operator Action Center.


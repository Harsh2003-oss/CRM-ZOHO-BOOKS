# Field Mapping Specification & API Call Budget

This document details the exact field-level mapping across HubSpot CRM, the Integration Gateway (MongoDB), and Zoho Books, along with data types, ownership, transformation rules, and API call budgets.

---

## 1. HubSpot Company / Contact ↔ Zoho Books Customer

| HubSpot Source Field | HubSpot Data Type | Zoho Books Target Field | Zoho Data Type | System of Record | Direction | Transformation / Rules |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `company.name` | `string` | `company_name` | `string` | HubSpot | CRM → Zoho | Trim whitespace; primary lookup key |
| `company.name` | `string` | `contact_name` | `string` | HubSpot | CRM → Zoho | Used if contact name is empty |
| `contact.firstname` + `lastname` | `string` | `contact_persons[0].first_name` / `last_name` | `string` | HubSpot | CRM → Zoho | Combined name string split or preserved |
| `contact.email` | `string` (email) | `contact_persons[0].email` / `email` | `string` (email) | HubSpot | CRM → Zoho | Lowercased, trimmed; used as secondary lookup key |
| `contact.phone` | `string` | `contact_persons[0].phone` | `string` | HubSpot | CRM → Zoho | E.164 formatted if present |
| — | — | `contact_id` | `string` | Zoho Books | Zoho → CRM | Stored in `CustomerMapping.zohoContactId` |

### Disambiguation Rule:
- 0 matches in Zoho: Create customer via `POST /books/v3/contacts` (`AUTO_CREATED`).
- Exactly 1 match: Link customer ID (`AUTOMATIC_EXACT`).
- Multiple matches (>1): Mark `AMBIGUOUS`, store `candidateMatches[]`, and require operator resolution via Dashboard. Never guess.

---

## 2. HubSpot Deal ↔ Zoho Books Sales Order

| HubSpot Source Field | HubSpot Data Type | Zoho Books Target Field | Zoho Data Type | System of Record | Direction | Transformation / Rules |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `deal.dealname` | `string` | `reference_number` | `string` | HubSpot | CRM → Zoho | Prefixed: `CRM_{dealId}` (deterministic idempotency key) |
| `deal.amount` | `number` (currency) | `line_items[0].rate` | `number` | HubSpot | CRM → Zoho | Deal subtotal (e.g. 120,000 AED) |
| — | — | `line_items[0].quantity` | `number` | Integration | Internal | Set to `1.0` |
| `deal.dealcurrencycode` | `string` | `currency_code` | `string` | HubSpot | CRM → Zoho | Standardized uppercase (e.g. `AED`) |
| — | — | `line_items[0].tax_id` | `string` | Zoho Books | Internal | Verified tax ID (5% VAT in UAE accounts) |
| `salesorder_id` | `string` | `deal.zoho_sales_order_id` | `string` | Zoho Books | Zoho → CRM | Written back to HubSpot custom deal property |
| `salesorder_number`| `string` | `deal.zoho_sales_order_number`| `string` | Zoho Books | Zoho → CRM | Written back to HubSpot custom deal property |

---

## 3. HubSpot Deal ↔ Zoho Books Milestone Invoices

| Milestone Index | Milestone Name | Trigger Condition | Quantity | Rate Formula | UAE VAT (5%) | Total Formula | Reference Number |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **M1** | Signing | Deal moves to `Closed Won` | `0.50` | `SO_Subtotal * 0.50` | `M1_Subtotal * 0.05` | `M1_Subtotal + Tax` | `CRM_{dealId}_M1` |
| **M2** | Go-Live | `confirmed_go_live_date` set | `0.30` | `SO_Subtotal * 0.30` | `M2_Subtotal * 0.05` | `M2_Subtotal + Tax` | `CRM_{dealId}_M2` |
| **M3** | 90 Days Post Go-Live | Current date ≥ `GoLive + 90d` | `0.20` | `SO_Subtotal - M1_Sub - M2_Sub` | `M3_Subtotal * 0.05` | `M3_Subtotal + Tax` | `CRM_{dealId}_M3` |

### Sales Order Linkage Payload:
To link invoices directly to the Sales Order in Zoho Books:
```json
{
  "customer_id": "{zohoContactId}",
  "salesorder_id": "{zohoSalesOrderId}",
  "reference_number": "CRM_{dealId}_M{index}",
  "line_items": [
    {
      "salesorder_item_id": "{zohoSalesOrderItemId}",
      "quantity": 0.5,
      "rate": 60000,
      "tax_percentage": 5
    }
  ]
}
```

---

## 4. Zoho Customer Payments ↔ HubSpot Financial Properties

| HubSpot Deal Property | Property Data Type | Zoho Books Source Field | Calculation / Formula | Direction | Update Condition |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `zoho_sales_order_id` | `string` | `salesorder.salesorder_id` | Direct mapping | Zoho → CRM | Written once upon confirmation |
| `zoho_sales_order_number` | `string` | `salesorder.salesorder_number` | Direct mapping | Zoho → CRM | Written once upon confirmation |
| `zoho_sales_order_total` | `number` | `salesorder.total` | `SO_Subtotal + SO_Tax` | Zoho → CRM | Only when changed |
| `zoho_total_invoiced` | `number` | `invoices[].total` | $\sum \text{Active Invoices Total}$ | Zoho → CRM | Only when changed |
| `zoho_percentage_invoiced`| `number` | Computed | $(\text{Total Invoiced} / \text{SO Total}) \times 100$ | Zoho → CRM | Rounded to 2 decimals |
| `zoho_total_collected` | `number` | `customerpayments[].amount` | $\sum \text{Active Payments Applied}$ | Zoho → CRM | Only when changed |
| `zoho_percentage_collected`| `number` | Computed | $(\text{Total Collected} / \text{SO Total}) \times 100$ | Zoho → CRM | Matched to total Sales Order |
| `zoho_invoiced_unpaid` | `number` | Computed | $\text{Total Invoiced} - \text{Total Collected}$ | Zoho → CRM | Always $\ge 0$ |
| `zoho_not_invoiced` | `number` | Computed | $\max(0, \text{SO Total} - \text{Total Invoiced})$ | Zoho → CRM | Decreases on M2/M3 |
| `zoho_next_due_date` | `date` | `invoices[].due_date` | $\min(\text{Due Date of Unpaid Invoices})$ | Zoho → CRM | Formatted `YYYY-MM-DD` |
| `zoho_is_overdue` | `string` | Computed | `"true"` if unpaid invoice past due; else `"false"` | Zoho → CRM | String per HubSpot portal type |

---

## 5. API Call Budget & Usage Analysis (Requirement 13)

The Complyance specification mandates reporting the exact number of API calls utilized by the integration.

### Scenario A: One Deal End-to-End from Closed Won to Paid
For a deal worth AED 120,000 billed across 3 milestones with 3 payments:

| Step / Operation | Zoho API Calls | Endpoints Called | Purpose |
| :--- | :---: | :--- | :--- |
| **1. Customer Matching** | **1** | `GET /books/v3/contacts?company_name=...` | Look up existing contact |
| **2. Sales Order Creation** | **2** | `POST /books/v3/salesorders`<br/>`POST /books/v3/salesorders/{id}/status/confirmed` | Create draft SO and mark confirmed |
| **3. Milestone 1 Creation** | **2** | `POST /books/v3/invoices`<br/>`POST /books/v3/invoices/{id}/status/sent` | Issue M1 (50%) and transition to sent |
| **4. Payment 1 Reverse Sync** | **1** | `GET /books/v3/customerpayments/{payment_id}` | Verify payment details upon webhook |
| **5. Milestone 2 (Go-Live)** | **2** | `POST /books/v3/invoices`<br/>`POST /books/v3/invoices/{id}/status/sent` | Issue M2 (30%) and transition to sent |
| **6. Payment 2 Reverse Sync** | **1** | `GET /books/v3/customerpayments/{payment_id}` | Verify payment details upon webhook |
| **7. Milestone 3 (90 Days)** | **2** | `POST /books/v3/invoices`<br/>`POST /books/v3/invoices/{id}/status/sent` | Issue M3 (20%) and transition to sent |
| **8. Payment 3 Reverse Sync** | **1** | `GET /books/v3/customerpayments/{payment_id}` | Verify final payment upon webhook |
| **TOTAL ZOHO CALLS** | **12** | — | **Entire lifecycle from Won to 100% Paid** |

*Note: Subsequent deals for the same company consume 0 calls for Step 1 because the customer mapping is cached in `CustomerMapping`.*

---

### Scenario B: Polling / Sync When Nothing Has Changed (No-Op Sync)
When a periodic reconciliation sync runs and no data has changed:

| Operation | Zoho API Calls | Explanation |
| :--- | :---: | :--- |
| **Delta Check** | **1** | `GET /books/v3/customerpayments?last_modified_time={lastSync}` (or invoices) |
| **Payload Hash / ETag** | **0** | Local hash comparison detects zero changes; no deals or invoices fetched |
| **HubSpot Update** | **0** | `lastSyncedValues` match; redundant HubSpot PATCH requests are suppressed |
| **TOTAL CALLS ON NO-OP**| **1** | Single lightweight delta query with zero write operations |


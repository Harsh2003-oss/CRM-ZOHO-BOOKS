/**
 * API Service for CRM & Zoho Books Dashboard
 * Communicates with backend /api/dashboard and /api/operator endpoints.
 */

const API_BASE = '/api';

export async function fetchSummary(currency = 'AED') {
  const res = await fetch(`${API_BASE}/dashboard/summary?currency=${encodeURIComponent(currency)}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch summary metrics');
  return data.data;
}

export async function fetchCollections({ page = 1, limit = 10, search = '', currency = 'AED', agingBasis = 'DUE_DATE' } = {}) {
  const params = new URLSearchParams({ page, limit, search, currency, agingBasis });
  const res = await fetch(`${API_BASE}/dashboard/collections?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch collections aging');
  return data.data;
}

export async function fetchLogs({ page = 1, limit = 15, system = '', isSuccess = '', search = '' } = {}) {
  const params = new URLSearchParams({ page, limit });
  if (system) params.append('system', system);
  if (isSuccess !== '') params.append('isSuccess', isSuccess);
  if (search) params.append('search', search);

  const res = await fetch(`${API_BASE}/dashboard/logs?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch integration logs');
  return data.data;
}

export async function fetchEvents({ page = 1, limit = 15, status = '', source = '' } = {}) {
  const params = new URLSearchParams({ page, limit });
  if (status) params.append('status', status);
  if (source) params.append('source', source);

  const res = await fetch(`${API_BASE}/dashboard/events?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch webhook events');
  return data.data;
}

export async function fetchExceptions() {
  const res = await fetch(`${API_BASE}/dashboard/exceptions`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch exceptions');
  return data.data;
}

// =============================================================================
// OPERATOR ACTIONS (PROTECTED BY OPERATOR KEY)
// =============================================================================

function getOperatorHeaders(operatorKey) {
  return {
    'Content-Type': 'application/json',
    'X-Operator-Key': operatorKey
  };
}

export async function retryWebhookEvent(eventId, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/retry-event/${eventId}`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Retry event failed');
  return data.data;
}

export async function retryHubSpotSync(crmDealId, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/retry-hubspot-sync/${crmDealId}`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Retry HubSpot sync failed');
  return data.data;
}

export async function resolveCustomerMapping({ mappingId, chosenZohoContactId, reason }, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/resolve-customer`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey),
    body: JSON.stringify({ mappingId, chosenZohoContactId, reason })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Customer resolution failed');
  return data.data;
}

export async function retryReconciliation(crmDealId, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/retry-reconciliation/${crmDealId}`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Retry reconciliation failed');
  return data.data;
}

export async function triggerPaymentSync(crmDealId, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/sync-payments/${crmDealId}`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey)
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'Payment sync failed');
  return data.data;
}

export async function fetchDeals({ page = 1, limit = 20, search = '', currency = '', syncStatus = '' } = {}) {
  const params = new URLSearchParams({ page, limit });
  if (search) params.append('search', search);
  if (currency) params.append('currency', currency);
  if (syncStatus) params.append('syncStatus', syncStatus);

  const res = await fetch(`${API_BASE}/dashboard/deals?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Failed to fetch deals');
  return data.data;
}

export async function reconcileHubSpotDeals({ dealId = null, limit = 100 } = {}, operatorKey) {
  const res = await fetch(`${API_BASE}/operator/reconcile-hubspot-deals`, {
    method: 'POST',
    headers: getOperatorHeaders(operatorKey),
    body: JSON.stringify({ dealId, limit })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || data.error || 'HubSpot reconciliation failed');
  return data.data;
}


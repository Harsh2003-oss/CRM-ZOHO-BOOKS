import React, { useState } from 'react';

export default function OperatorPage({
  exceptionsData,
  operatorKey,
  onResolveCustomer,
  onRetryReconciliation,
  onRetryHubSpotSync,
  onRetryEvent,
  onReconcileHubSpotDeals
}) {
  const [selectedCandidates, setSelectedCandidates] = useState({});
  const [reconcileDealId, setReconcileDealId] = useState('');

  const ambiguousCustomers = exceptionsData?.ambiguousCustomers || [];
  const reconciliationRequired = exceptionsData?.reconciliationRequired || [];
  const hubspotSyncFailed = exceptionsData?.hubspotSyncFailed || [];
  const failedWebhookEvents = exceptionsData?.failedWebhookEvents || [];
  const requiresManualMatch = exceptionsData?.requiresManualMatch || [];

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 text-white p-4 rounded-xl shadow-md flex justify-between items-center">
        <div>
          <h2 className="text-base font-bold">Operator Exception Center</h2>
          <p className="text-xs text-slate-300">
            Safe operator intervention for customer ambiguity, retryable sync errors, and webhook queue failures.
          </p>
        </div>
        <span className="px-3 py-1 bg-indigo-600 text-xs font-semibold rounded-md">
          Auth Status: {operatorKey ? 'Active' : 'Unauthenticated'}
        </span>
      </div>

      {/* HubSpot Deal Reconciliation Panel */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-indigo-50 border-b border-indigo-100 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-bold text-indigo-900">
              HubSpot CRM Closed Won Reconciliation
            </h3>
            <p className="text-xs text-indigo-700">
              Fetch Closed Won deals missed due to network drops or unconfigured webhooks. Idempotent & non-destructive.
            </p>
          </div>
          <span className="px-2.5 py-1 bg-indigo-200 text-indigo-900 text-[10px] font-bold rounded">
            API Reconciler
          </span>
        </div>

        <div className="p-6">
          <div className="flex flex-col sm:flex-row gap-3 items-center">
            <input
              type="text"
              placeholder="Specific HubSpot Deal ID (optional, e.g. 360906792672)"
              value={reconcileDealId}
              onChange={(e) => setReconcileDealId(e.target.value)}
              className="flex-1 px-3.5 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
            />
            <button
              onClick={() => {
                if (onReconcileHubSpotDeals) {
                  onReconcileHubSpotDeals({ dealId: reconcileDealId.trim() || null });
                  setReconcileDealId('');
                }
              }}
              disabled={!operatorKey}
              className="w-full sm:w-auto px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-40 transition shadow-sm whitespace-nowrap"
            >
              {reconcileDealId.trim() ? `Reconcile Deal ${reconcileDealId.trim()}` : 'Scan & Reconcile Closed Won Deals'}
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            💡 Leaves empty to scan all Closed Won deals in HubSpot, or specify a deal ID for targeted reconciliation. Safeguards prevent duplicate customers, sales orders, or invoices.
          </p>
        </div>
      </div>

      {/* 1. Ambiguous Customer Mappings */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-amber-50 border-b border-amber-100 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-bold text-amber-900">
              Ambiguous Customer Mappings ({ambiguousCustomers.length})
            </h3>
            <p className="text-xs text-amber-700">
              Deals paused because HubSpot company/contact resolved to multiple Zoho candidates.
            </p>
          </div>
        </div>

        <div className="p-6">
          {ambiguousCustomers.length === 0 ? (
            <p className="text-xs text-slate-500">No customer ambiguities pending resolution.</p>
          ) : (
            <div className="space-y-6">
              {ambiguousCustomers.map((mapping) => (
                <div key={mapping._id} className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-xs font-bold text-slate-900">
                        {mapping.companyName || mapping.contactName || 'Ambiguous Entity'}
                      </span>
                      <p className="text-xs text-slate-500">
                        Company ID: {mapping.hubspotCompanyId || '—'} | Contact Email: {mapping.contactEmail || '—'}
                      </p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-900">
                      Action Required
                    </span>
                  </div>

                  {/* Candidate selection radio group */}
                  <div className="space-y-2 mt-2">
                    <p className="text-xs font-semibold text-slate-700">Choose Verified Zoho Customer Candidate:</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {mapping.candidateMatches?.map((c) => (
                        <label
                          key={c.contactId}
                          className={`flex items-start space-x-2 p-2.5 rounded border text-xs cursor-pointer transition ${
                            selectedCandidates[mapping._id] === c.contactId
                              ? 'border-indigo-600 bg-indigo-50 text-indigo-900'
                              : 'border-slate-300 bg-white hover:bg-slate-100'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`candidate_${mapping._id}`}
                            value={c.contactId}
                            checked={selectedCandidates[mapping._id] === c.contactId}
                            onChange={() =>
                              setSelectedCandidates({ ...selectedCandidates, [mapping._id]: c.contactId })
                            }
                            className="mt-0.5 text-indigo-600 focus:ring-indigo-500"
                          />
                          <div>
                            <p className="font-bold">{c.contactName || c.companyName}</p>
                            <p className="text-[11px] text-slate-500">Zoho ID: {c.contactId}</p>
                            {c.email && <p className="text-[11px] text-slate-500">Email: {c.email}</p>}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      disabled={!selectedCandidates[mapping._id]}
                      onClick={() =>
                        onResolveCustomer({
                          mappingId: mapping._id,
                          chosenZohoContactId: selectedCandidates[mapping._id],
                          companyName: mapping.companyName || mapping.contactName
                        })
                      }
                      className="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-40 transition shadow-sm"
                    >
                      Resolve & Link Customer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 2. Reconciliation Required */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-rose-50 border-b border-rose-100">
          <h3 className="text-sm font-bold text-rose-900">
            Reconciliation Required ({reconciliationRequired.length})
          </h3>
          <p className="text-xs text-rose-700">
            Deals blocked due to network drops during Sales Order or Invoice creation to prevent duplicate POSTs.
          </p>
        </div>

        <div className="p-6">
          {reconciliationRequired.length === 0 ? (
            <p className="text-xs text-slate-500">No deals currently in RECONCILIATION_REQUIRED state.</p>
          ) : (
            <div className="space-y-3">
              {reconciliationRequired.map((deal) => (
                <div key={deal._id} className="flex justify-between items-center p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <div>
                    <p className="text-xs font-bold text-slate-900">CRM Deal: {deal.crmDealId}</p>
                    <p className="text-[11px] text-slate-500">
                      Reason: {deal.reconciliationReason || deal.failureReason || 'Remote POST uncertain timeout'}
                    </p>
                  </div>
                  <button
                    onClick={() => onRetryReconciliation(deal.crmDealId)}
                    className="px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-100 hover:bg-rose-200 rounded-md transition"
                  >
                    Retry Reconciliation
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 3. HubSpot Sync Failures */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-orange-50 border-b border-orange-100">
          <h3 className="text-sm font-bold text-orange-900">
            HubSpot Sync Failed ({hubspotSyncFailed.length})
          </h3>
          <p className="text-xs text-orange-700">
            Zoho Books operations succeeded, but updating deal properties in HubSpot timed out or failed.
          </p>
        </div>

        <div className="p-6">
          {hubspotSyncFailed.length === 0 ? (
            <p className="text-xs text-slate-500">No deals in HUBSPOT_SYNC_FAILED state.</p>
          ) : (
            <div className="space-y-3">
              {hubspotSyncFailed.map((deal) => (
                <div key={deal._id} className="flex justify-between items-center p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <div>
                    <p className="text-xs font-bold text-slate-900">CRM Deal: {deal.crmDealId}</p>
                    <p className="text-[11px] text-slate-500">Last error: {deal.failureReason || 'HubSpot API Error'}</p>
                  </div>
                  <button
                    onClick={() => onRetryHubSpotSync(deal.crmDealId)}
                    className="px-3 py-1.5 text-xs font-semibold text-orange-700 bg-orange-100 hover:bg-orange-200 rounded-md transition"
                  >
                    Retry HubSpot Sync
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 4. Failed Webhook Events */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-slate-100 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-900">
            Failed Webhook Events ({failedWebhookEvents.length})
          </h3>
          <p className="text-xs text-slate-600">
            Events that exceeded worker processing retries or encountered unhandled runtime errors.
          </p>
        </div>

        <div className="p-6">
          {failedWebhookEvents.length === 0 ? (
            <p className="text-xs text-slate-500">No failed webhook events in queue.</p>
          ) : (
            <div className="space-y-3">
              {failedWebhookEvents.map((evt) => (
                <div key={evt._id} className="flex justify-between items-center p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <div>
                    <span className="text-xs font-bold text-slate-900">{evt.eventId}</span>
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-800">{evt.source}</span>
                    <p className="text-[11px] text-rose-600 mt-0.5 font-mono">Error: {evt.error || 'Failed'}</p>
                  </div>
                  <button
                    onClick={() => onRetryEvent(evt.eventId)}
                    className="px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-100 hover:bg-indigo-200 rounded-md transition"
                  >
                    Re-queue Event
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


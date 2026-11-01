import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import Toast from './components/Toast';
import OperatorKeyModal from './components/OperatorKeyModal';
import ConfirmModal from './components/ConfirmModal';
import OverviewPage from './pages/OverviewPage';
import CollectionsPage from './pages/CollectionsPage';
import LogsPage from './pages/LogsPage';
import OperatorPage from './pages/OperatorPage';
import {
  fetchSummary,
  fetchCollections,
  fetchLogs,
  fetchEvents,
  fetchExceptions,
  retryWebhookEvent,
  retryHubSpotSync,
  resolveCustomerMapping,
  retryReconciliation,
  triggerPaymentSync,
  reconcileHubSpotDeals
} from './services/api';

const DEFAULT_OPERATOR_KEY = 'operator_super_secret_key_2026';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [operatorKey, setOperatorKey] = useState(
    localStorage.getItem('OPERATOR_KEY') || DEFAULT_OPERATOR_KEY
  );
  const [toast, setToast] = useState(null);

  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    actionType: null,
    payload: null,
    isExecuting: false
  });

  // Data States
  const [summary, setSummary] = useState(null);
  const [collectionsData, setCollectionsData] = useState(null);
  const [logsData, setLogsData] = useState(null);
  const [eventsData, setEventsData] = useState(null);
  const [exceptionsData, setExceptionsData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Filter States
  const [collectionsSearch, setCollectionsSearch] = useState('');
  const [collectionsPage, setCollectionsPage] = useState(1);
  const [agingBasis, setAgingBasis] = useState('DUE_DATE');
  const [logsPage, setLogsPage] = useState(1);
  const [logsFilter, setLogsFilter] = useState({ system: '', isSuccess: '', search: '' });

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleSaveOperatorKey = (newKey) => {
    setOperatorKey(newKey);
    localStorage.setItem('OPERATOR_KEY', newKey);
    showToast('Operator authorization key updated.');
  };

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, coll, logs, events, exceptions] = await Promise.all([
        fetchSummary(),
        fetchCollections({ page: collectionsPage, limit: 10, search: collectionsSearch, agingBasis }),
        fetchLogs({ page: logsPage, limit: 15, ...logsFilter }),
        fetchEvents({ limit: 15 }),
        fetchExceptions()
      ]);

      setSummary(sum);
      setCollectionsData(coll);
      setLogsData(logs);
      setEventsData(events);
      setExceptionsData(exceptions);
    } catch (err) {
      showToast('Error loading dashboard data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [collectionsPage, collectionsSearch, agingBasis, logsPage, logsFilter]);

  useEffect(() => {
    localStorage.setItem('OPERATOR_KEY', operatorKey);
  }, [operatorKey]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  // Execute Operator Action from Confirmation Modal
  const handleConfirmAction = async () => {
    if (!confirmModal.actionType || !confirmModal.payload) return;
    setConfirmModal((prev) => ({ ...prev, isExecuting: true }));

    try {
      const { actionType, payload } = confirmModal;

      if (actionType === 'RETRY_EVENT') {
        await retryWebhookEvent(payload.eventId, operatorKey);
      } else if (actionType === 'RETRY_HUBSPOT') {
        await retryHubSpotSync(payload.crmDealId, operatorKey);
      } else if (actionType === 'RETRY_RECONCILIATION') {
        await retryReconciliation(payload.crmDealId, operatorKey);
      } else if (actionType === 'RESOLVE_CUSTOMER') {
        await resolveCustomerMapping(
          {
            mappingId: payload.mappingId,
            chosenZohoContactId: payload.chosenZohoContactId,
            reason: 'Resolved by operator via Vite dashboard'
          },
          operatorKey
        );
      } else if (actionType === 'SYNC_PAYMENTS') {
        await triggerPaymentSync(payload.crmDealId, operatorKey);
      } else if (actionType === 'RECONCILE_HUBSPOT') {
        await reconcileHubSpotDeals({ dealId: payload.dealId, limit: payload.limit }, operatorKey);
      }

      showToast('Operator action executed successfully!');
      setConfirmModal({ isOpen: false, title: '', message: '', actionType: null, payload: null, isExecuting: false });
      fetchAllData();
    } catch (err) {
      showToast('Action failed: ' + err.message, 'error');
      setConfirmModal((prev) => ({ ...prev, isExecuting: false }));
    }
  };

  const totalExceptions =
    (exceptionsData?.summary?.ambiguousCustomersCount || 0) +
    (exceptionsData?.summary?.reconciliationRequiredCount || 0) +
    (exceptionsData?.summary?.hubspotSyncFailedCount || 0) +
    (exceptionsData?.summary?.failedWebhookEventsCount || 0);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onRefresh={fetchAllData}
        loading={loading}
      />

      <Toast toast={toast} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
        {activeTab === 'overview' && <OverviewPage summary={summary} />}

        {activeTab === 'collections' && (
          <CollectionsPage
            collectionsData={collectionsData}
            search={collectionsSearch}
            onSearchChange={(val) => {
              setCollectionsSearch(val);
              setCollectionsPage(1);
            }}
            agingBasis={agingBasis}
            onAgingBasisChange={setAgingBasis}
            page={collectionsPage}
            onPageChange={setCollectionsPage}
            onTriggerSyncPayments={(dealId) =>
              setConfirmModal({
                isOpen: true,
                title: 'Trigger Payment Sync',
                message: `Poll Zoho Books directly for latest payments on deal ${dealId}?`,
                actionType: 'SYNC_PAYMENTS',
                payload: { crmDealId: dealId },
                isExecuting: false
              })
            }
          />
        )}

        {activeTab === 'logs' && (
          <LogsPage
            logsData={logsData}
            eventsData={eventsData}
            logsFilter={logsFilter}
            onFilterChange={setLogsFilter}
          />
        )}

        {activeTab === 'operator' && (
          <OperatorPage
            exceptionsData={exceptionsData}
            operatorKey={operatorKey}
            onResolveCustomer={({ mappingId, chosenZohoContactId, companyName }) =>
              setConfirmModal({
                isOpen: true,
                title: 'Resolve Customer Ambiguity',
                message: `Link customer "${companyName}" to verified Zoho Contact ID "${chosenZohoContactId}"?`,
                actionType: 'RESOLVE_CUSTOMER',
                payload: { mappingId, chosenZohoContactId },
                isExecuting: false
              })
            }
            onRetryReconciliation={(dealId) =>
              setConfirmModal({
                isOpen: true,
                title: 'Execute Reconciliation',
                message: `Re-evaluate remote Zoho Books state for deal ${dealId}?`,
                actionType: 'RETRY_RECONCILIATION',
                payload: { crmDealId: dealId },
                isExecuting: false
              })
            }
            onRetryHubSpotSync={(dealId) =>
              setConfirmModal({
                isOpen: true,
                title: 'Retry HubSpot Synchronization',
                message: `Push latest Zoho financial metrics to HubSpot deal ${dealId}?`,
                actionType: 'RETRY_HUBSPOT',
                payload: { crmDealId: dealId },
                isExecuting: false
              })
            }
            onRetryEvent={(eventId) =>
              setConfirmModal({
                isOpen: true,
                title: 'Retry Webhook Event',
                message: `Re-queue event ${eventId} for immediate worker processing?`,
                actionType: 'RETRY_EVENT',
                payload: { eventId },
                isExecuting: false
              })
            }
            onReconcileHubSpotDeals={({ dealId, limit }) =>
              setConfirmModal({
                isOpen: true,
                title: 'Reconcile HubSpot Deals',
                message: dealId
                  ? `Fetch and reconcile HubSpot deal ${dealId} into integration ledger?`
                  : 'Scan HubSpot CRM for all Closed Won deals and reconcile missing records?',
                actionType: 'RECONCILE_HUBSPOT',
                payload: { dealId, limit },
                isExecuting: false
              })
            }
          />
        )}
      </main>

      <ConfirmModal
        modalState={confirmModal}
        onClose={() =>
          setConfirmModal({ isOpen: false, title: '', message: '', actionType: null, payload: null, isExecuting: false })
        }
        onConfirm={handleConfirmAction}
      />
    </div>
  );
}


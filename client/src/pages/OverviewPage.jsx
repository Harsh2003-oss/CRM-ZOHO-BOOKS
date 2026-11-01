import React from 'react';

function formatCurrency(val, code = 'AED') {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return `${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

export default function OverviewPage({ summary }) {
  const totals = summary?.totals;
  const currency = summary?.activeCurrency || 'AED';

  return (
    <div className="space-y-6">
      {/* Notice if unknown payment balances exist */}
      {totals?.unknownBalancesCount > 0 && (
        <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-md">
          <div className="flex">
            <div className="flex-shrink-0 text-amber-500 font-bold text-lg">⚠️</div>
            <div className="ml-3">
              <p className="text-sm font-semibold text-amber-800">
                {totals.unknownBalancesCount} deal(s) have PAYMENT_INFO_UNAVAILABLE
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Unknown payment balances are strictly preserved as undetermined and never fabricated as zero.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* KPI Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Contract Value */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Contract Value</p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {formatCurrency(totals?.totalContractValue, currency)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Confirmed SOs: <span className="font-semibold text-slate-700">{totals?.confirmedSalesOrdersCount || 0}</span> ({formatCurrency(totals?.confirmedSalesOrdersTotal, currency)})
          </p>
        </div>

        {/* Card 2: Total Invoiced */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Invoiced</p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">
            {formatCurrency(totals?.totalInvoiced, currency)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Not Yet Invoiced: <span className="font-semibold text-slate-700">{formatCurrency(totals?.amountNotInvoiced, currency)}</span>
          </p>
        </div>

        {/* Card 3: Total Collected */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Collected</p>
          <p className="text-2xl font-bold text-emerald-600 mt-2">
            {formatCurrency(totals?.totalCollected, currency)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Contract Collection:{' '}
            <span className="font-semibold text-emerald-700">
              {totals?.totalContractValue > 0
                ? ((totals.totalCollected / totals.totalContractValue) * 100).toFixed(1)
                : 0}
              %
            </span>
          </p>
        </div>

        {/* Card 4: Total Outstanding & Overdue */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Invoiced But Unpaid</p>
          <p className="text-2xl font-bold text-amber-600 mt-2">
            {formatCurrency(totals?.amountInvoicedUnpaid, currency)}
          </p>
          <p className="text-xs text-rose-600 font-semibold mt-1">
            Overdue Outstanding: {formatCurrency(totals?.totalOverdue, currency)}
          </p>
        </div>
      </div>

      {/* Secondary Metric Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">Customers with Outstanding Balances</p>
            <p className="text-xl font-bold text-slate-900 mt-1">{totals?.customersWithOutstandingCount || 0}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold">
            👥
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">Deals Awaiting Next Milestone</p>
            <p className="text-xl font-bold text-slate-900 mt-1">{totals?.dealsAwaitingMilestonesCount || 0}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold">
            ⏳
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">Pending / Failed Webhook Events</p>
            <p className="text-xl font-bold text-slate-900 mt-1">
              {summary?.operationalCounts?.pendingEventsCount || 0} Pending /{' '}
              <span className="text-rose-600">{summary?.operationalCounts?.failedEventsCount || 0} Failed</span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center text-rose-600 font-bold">
            ⚡
          </div>
        </div>
      </div>

      {/* Visual Contract Fulfillment Breakdown */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4">
          Contract Lifecycle & Cash Realization (Gross {currency} Basis)
        </h3>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
              <span>
                Collected: {formatCurrency(totals?.totalCollected, currency)} (
                {totals?.totalContractValue > 0
                  ? ((totals.totalCollected / totals.totalContractValue) * 100).toFixed(1)
                  : 0}
                %)
              </span>
              <span>Invoiced Unpaid: {formatCurrency(totals?.amountInvoicedUnpaid, currency)}</span>
              <span>Not Yet Invoiced: {formatCurrency(totals?.amountNotInvoiced, currency)}</span>
            </div>
            <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden flex shadow-inner">
              <div
                style={{
                  width: `${
                    totals?.totalContractValue > 0
                      ? (totals.totalCollected / totals.totalContractValue) * 100
                      : 0
                  }%`
                }}
                className="bg-emerald-500 h-full transition-all duration-500"
                title="Collected"
              ></div>
              <div
                style={{
                  width: `${
                    totals?.totalContractValue > 0
                      ? (totals.amountInvoicedUnpaid / totals.totalContractValue) * 100
                      : 0
                  }%`
                }}
                className="bg-amber-400 h-full transition-all duration-500"
                title="Invoiced Unpaid"
              ></div>
              <div
                style={{
                  width: `${
                    totals?.totalContractValue > 0
                      ? (totals.amountNotInvoiced / totals.totalContractValue) * 100
                      : 0
                  }%`
                }}
                className="bg-slate-300 h-full transition-all duration-500"
                title="Not Yet Invoiced"
              ></div>
            </div>
          </div>
        </div>
      </div>

      {/* Tracked CRM Deals Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Tracked CRM Deals ({summary?.deals?.length || 0})
            </h3>
            <p className="text-xs text-slate-500">
              Deals synchronized or reconciled from HubSpot CRM into the integration ledger.
            </p>
          </div>
          <span className="text-xs font-semibold px-2.5 py-1 bg-slate-200 text-slate-800 rounded-md">
            {summary?.activeCurrency || 'AED'} Ledger
          </span>
        </div>

        <div className="overflow-x-auto">
          {(!summary?.deals || summary.deals.length === 0) ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No CRM deals tracked yet. Use the Operator tab to reconcile Closed Won deals from HubSpot.
            </div>
          ) : (
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-100 text-slate-700 uppercase font-semibold text-[11px] border-b border-slate-200">
                <tr>
                  <th className="px-5 py-3">Deal / CRM ID</th>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Contract Value</th>
                  <th className="px-5 py-3">Invoiced / Not Invoiced</th>
                  <th className="px-5 py-3">Sync Status</th>
                  <th className="px-5 py-3">Sales Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.deals.map((deal) => {
                  const statusColors = {
                    PENDING: 'bg-amber-100 text-amber-800',
                    REQUIRES_MANUAL_MATCH: 'bg-rose-100 text-rose-800',
                    SALES_ORDER_DRAFT: 'bg-blue-100 text-blue-800',
                    SALES_ORDER_CONFIRMED: 'bg-indigo-100 text-indigo-800',
                    M1_INVOICED: 'bg-emerald-100 text-emerald-800',
                    M2_INVOICED: 'bg-emerald-100 text-emerald-800',
                    M3_INVOICED: 'bg-emerald-100 text-emerald-800',
                    SYNCED: 'bg-emerald-100 text-emerald-800',
                    FAILED: 'bg-rose-100 text-rose-800'
                  };
                  const badgeClass = statusColors[deal.syncStatus] || 'bg-slate-100 text-slate-800';

                  return (
                    <tr key={deal.crmDealId} className="hover:bg-slate-50 transition">
                      <td className="px-5 py-3.5">
                        <p className="font-bold text-slate-900">{deal.dealName || 'Unnamed Deal'}</p>
                        <p className="text-[11px] text-slate-400 font-mono">ID: {deal.crmDealId}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-800">{deal.customerName || '—'}</p>
                      </td>
                      <td className="px-5 py-3.5 font-bold text-slate-900">
                        {formatCurrency(deal.contractValue, deal.currencyCode || currency)}
                      </td>
                      <td className="px-5 py-3.5">
                        <p className="text-emerald-600 font-medium">Invoiced: {formatCurrency(deal.totalInvoicedAmount, deal.currencyCode || currency)}</p>
                        <p className="text-slate-400 text-[11px]">Uninvoiced: {formatCurrency(deal.amountNotInvoiced, deal.currencyCode || currency)}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${badgeClass}`}>
                          {deal.syncStatus}
                        </span>
                        {deal.failureReason && (
                          <p className="text-[10px] text-rose-600 mt-1 max-w-xs truncate" title={deal.failureReason}>
                            {deal.failureReason}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {deal.salesOrderStatus === 'CONFIRMED' ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            {deal.zohoSalesOrderNumber || 'CONFIRMED'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
                            {deal.salesOrderStatus || 'NONE'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


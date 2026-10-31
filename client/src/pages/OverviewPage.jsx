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
    </div>
  );
}


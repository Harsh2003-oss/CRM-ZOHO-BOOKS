import React from 'react';

function formatCurrency(val, code = 'AED') {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return `${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

export default function CollectionsPage({
  collectionsData,
  search,
  onSearchChange,
  page,
  onPageChange,
  onTriggerSyncPayments
}) {
  const agingTotals = collectionsData?.agingSummaryTotals;
  const customers = collectionsData?.customers || [];
  const pagination = collectionsData?.pagination;
  const currency = collectionsData?.currency || 'AED';

  return (
    <div className="space-y-6">
      {/* Search & Actions Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap justify-between items-center gap-4">
        <div className="flex-1 min-w-[260px]">
          <input
            type="text"
            placeholder="Search by customer name, email, deal ID, invoice reference..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="text-xs text-slate-500 font-medium">
          Aging computed strictly from Zoho invoice due dates. Excludes fully paid and unconfirmed milestones.
        </div>
      </div>

      {/* Aging Summary KPI Banner */}
      {agingTotals && (
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <div className="bg-white p-3 rounded-lg border border-slate-200 text-center shadow-sm">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Current</p>
            <p className="text-sm font-bold text-emerald-600 mt-1">
              {formatCurrency(agingTotals.current, currency)}
            </p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 text-center shadow-sm">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">1-30 Days</p>
            <p className="text-sm font-bold text-amber-600 mt-1">
              {formatCurrency(agingTotals.days1To30, currency)}
            </p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 text-center shadow-sm">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">31-60 Days</p>
            <p className="text-sm font-bold text-orange-600 mt-1">
              {formatCurrency(agingTotals.days31To60, currency)}
            </p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 text-center shadow-sm">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">61-90 Days</p>
            <p className="text-sm font-bold text-rose-500 mt-1">
              {formatCurrency(agingTotals.days61To90, currency)}
            </p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 text-center shadow-sm">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">90+ Days</p>
            <p className="text-sm font-bold text-rose-700 mt-1">
              {formatCurrency(agingTotals.days90Plus, currency)}
            </p>
          </div>
          <div className="bg-slate-900 p-3 rounded-lg text-center text-white shadow-sm">
            <p className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">Total Outstanding</p>
            <p className="text-sm font-bold text-white mt-1">
              {formatCurrency(agingTotals.totalOutstanding, currency)}
            </p>
          </div>
        </div>
      )}

      {/* Collections Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm text-left">
            <thead className="bg-slate-50 text-slate-600 font-semibold text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-3 py-3 text-right">Current</th>
                <th className="px-3 py-3 text-right">1-30d</th>
                <th className="px-3 py-3 text-right">31-60d</th>
                <th className="px-3 py-3 text-right">61-90d</th>
                <th className="px-3 py-3 text-right">90d+</th>
                <th className="px-4 py-3 text-right">Outstanding</th>
                <th className="px-4 py-3">Oldest Unpaid Invoice</th>
                <th className="px-3 py-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {customers.length === 0 ? (
                <tr>
                  <td colSpan="9" className="px-4 py-8 text-center text-slate-500 text-sm">
                    No active customer outstanding balances found.
                  </td>
                </tr>
              ) : (
                customers.map((cust) => (
                  <tr key={cust.customerId} className="hover:bg-slate-50 transition">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{cust.customerName}</div>
                      <div className="text-xs text-slate-500">{cust.customerEmail || cust.customerId}</div>
                    </td>
                    <td className="px-3 py-3 text-right text-slate-700">{formatCurrency(cust.current, currency)}</td>
                    <td className="px-3 py-3 text-right font-medium text-amber-600">
                      {cust.days1To30 > 0 ? formatCurrency(cust.days1To30, currency) : '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-medium text-orange-600">
                      {cust.days31To60 > 0 ? formatCurrency(cust.days31To60, currency) : '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-medium text-rose-500">
                      {cust.days61To90 > 0 ? formatCurrency(cust.days61To90, currency) : '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-bold text-rose-700">
                      {cust.days90Plus > 0 ? formatCurrency(cust.days90Plus, currency) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">
                      {formatCurrency(cust.totalOutstanding, currency)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {cust.oldestUnpaidInvoice ? (
                        <div>
                          <span className="font-semibold text-slate-800">
                            {cust.oldestUnpaidInvoice.invoiceNumber ||
                              cust.oldestUnpaidInvoice.referenceNumber ||
                              cust.oldestUnpaidInvoice.invoiceId}
                          </span>
                          <div className="text-slate-500">
                            Due: {cust.oldestUnpaidInvoice.dueDate ? new Date(cust.oldestUnpaidInvoice.dueDate).toLocaleDateString() : '—'}
                          </div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {cust.relatedDeals?.length > 0 && (
                        <button
                          onClick={() => onTriggerSyncPayments(cust.relatedDeals[0])}
                          className="px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded border border-indigo-200 transition"
                        >
                          Sync Payments
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {pagination && pagination.totalPages > 1 && (
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs text-slate-500">
            <span>
              Page {pagination.page} of {pagination.totalPages} ({pagination.totalRecords} customers)
            </span>
            <div className="space-x-2">
              <button
                disabled={pagination.page <= 1}
                onClick={() => onPageChange(Math.max(1, page - 1))}
                className="px-3 py-1 bg-white border border-slate-300 rounded text-slate-700 disabled:opacity-50 transition"
              >
                Previous
              </button>
              <button
                disabled={!pagination.hasMore}
                onClick={() => onPageChange(page + 1)}
                className="px-3 py-1 bg-white border border-slate-300 rounded text-slate-700 disabled:opacity-50 transition"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


import React, { useState } from 'react';

function formatCurrency(val, code = 'AED') {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return `${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

export default function CollectionsPage({
  collectionsData,
  search,
  onSearchChange,
  agingBasis = 'DUE_DATE',
  onAgingBasisChange,
  page,
  onPageChange,
  onTriggerSyncPayments
}) {
  const [selectedCustomer, setSelectedCustomer] = useState(null);

  const agingTotals = collectionsData?.agingSummaryTotals;
  const customers = collectionsData?.customers || [];
  const pagination = collectionsData?.pagination;
  const currency = collectionsData?.currency || 'AED';

  return (
    <div className="space-y-6">
      {/* Search & Actions Bar with Aging Mode Selector */}
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

        {/* Aging Basis Mode Switcher */}
        <div className="flex items-center space-x-2">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Aging Mode:</span>
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-100 text-xs font-medium">
            <button
              type="button"
              onClick={() => onAgingBasisChange && onAgingBasisChange('DUE_DATE')}
              className={`px-3 py-1 rounded-md transition ${
                agingBasis === 'DUE_DATE'
                  ? 'bg-white text-indigo-700 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              By Due Date (Overdue)
            </button>
            <button
              type="button"
              onClick={() => onAgingBasisChange && onAgingBasisChange('INVOICE_DATE')}
              className={`px-3 py-1 rounded-md transition ${
                agingBasis === 'INVOICE_DATE'
                  ? 'bg-white text-indigo-700 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              By Invoice Date (Age)
            </button>
          </div>
        </div>
      </div>

      {/* Explanatory Banner */}
      <div className="bg-indigo-50/60 border border-indigo-100 rounded-lg px-4 py-2.5 text-xs text-indigo-900 flex items-center justify-between">
        <div>
          <span className="font-semibold">Notice:</span>{' '}
          {agingBasis === 'DUE_DATE'
            ? 'In "By Due Date" mode (accounting standard), invoices due in the future (e.g. Net 30 due 12/01/2026) are categorized under Current (not overdue). They transition to 1-30d only after passing their due date.'
            : 'In "By Invoice Date" mode, aging is computed from the invoice creation date (invoices issued within 30 days appear in 1-30 Days).'}
        </div>
        <div className="text-[11px] text-indigo-600 font-medium whitespace-nowrap ml-4">
          Click any customer row to inspect invoices
        </div>
      </div>

      {/* Aging Summary KPI Banner (The 6 boxes) */}
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
                  <tr
                    key={cust.customerId}
                    onClick={() => setSelectedCustomer(cust)}
                    className="hover:bg-indigo-50/40 cursor-pointer transition"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                        <span>{cust.customerName}</span>
                        {cust.invoicesCount > 1 && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
                            {cust.invoicesCount} inv
                          </span>
                        )}
                      </div>
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
                    <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setSelectedCustomer(cust)}
                          className="px-2 py-1 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 rounded border border-slate-300 transition"
                          title="Inspect Invoices Dialogue"
                        >
                          View Invoices
                        </button>
                        {cust.relatedDeals?.length > 0 && (
                          <button
                            onClick={() => onTriggerSyncPayments(cust.relatedDeals[0])}
                            className="px-2 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded border border-indigo-200 transition"
                            title="Poll Zoho for payments"
                          >
                            Sync Payments
                          </button>
                        )}
                      </div>
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

      {/* Customer Invoices Dialogue Box (Modal) */}
      {selectedCustomer && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-100 flex justify-between items-start bg-slate-50/70">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <span>{selectedCustomer.customerName}</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">
                    {selectedCustomer.invoicesCount} {selectedCustomer.invoicesCount === 1 ? 'Invoice' : 'Invoices'}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Zoho Contact ID: <span className="font-mono text-slate-700">{selectedCustomer.customerId}</span>
                  {selectedCustomer.customerEmail && ` • ${selectedCustomer.customerEmail}`}
                </p>
              </div>
              <button
                onClick={() => setSelectedCustomer(null)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4">
              {/* Customer Aging Breakdown Sub-Cards */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs">
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">Current</p>
                  <p className="font-bold text-emerald-600 mt-0.5">{formatCurrency(selectedCustomer.current, currency)}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">1-30d</p>
                  <p className="font-bold text-amber-600 mt-0.5">{formatCurrency(selectedCustomer.days1To30, currency)}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">31-60d</p>
                  <p className="font-bold text-orange-600 mt-0.5">{formatCurrency(selectedCustomer.days31To60, currency)}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">61-90d</p>
                  <p className="font-bold text-rose-500 mt-0.5">{formatCurrency(selectedCustomer.days61To90, currency)}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold uppercase">90d+</p>
                  <p className="font-bold text-rose-700 mt-0.5">{formatCurrency(selectedCustomer.days90Plus, currency)}</p>
                </div>
                <div className="bg-slate-900 p-2 rounded-lg text-white">
                  <p className="text-[10px] text-slate-300 font-semibold uppercase">Total</p>
                  <p className="font-bold mt-0.5">{formatCurrency(selectedCustomer.totalOutstanding, currency)}</p>
                </div>
              </div>

              {/* Invoices List */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="min-w-full divide-y divide-slate-200 text-xs text-left">
                  <thead className="bg-slate-50 text-slate-600 font-semibold uppercase">
                    <tr>
                      <th className="px-3 py-2.5">Milestone</th>
                      <th className="px-3 py-2.5">Invoice #</th>
                      <th className="px-3 py-2.5 text-right">Balance</th>
                      <th className="px-3 py-2.5">Due Date</th>
                      <th className="px-3 py-2.5">Aging Classification</th>
                      <th className="px-3 py-2.5 text-center">Zoho Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {selectedCustomer.invoices.map((inv, idx) => {
                      const isPastDue = inv.dueDate && new Date(inv.dueDate) < new Date();
                      const daysDiff = inv.dueDate
                        ? Math.floor((new Date().getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24))
                        : 0;

                      return (
                        <tr key={inv.invoiceId || idx} className="hover:bg-slate-50 transition">
                          <td className="px-3 py-2.5 font-medium text-slate-900">
                            {inv.milestoneName || 'Milestone Invoice'}
                            <div className="text-[10px] text-slate-400 font-mono">{inv.referenceNumber}</div>
                          </td>
                          <td className="px-3 py-2.5 font-semibold text-slate-800">
                            {inv.invoiceNumber || inv.invoiceId}
                          </td>
                          <td className="px-3 py-2.5 text-right font-bold text-slate-900">
                            {formatCurrency(inv.balance, currency)}
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">
                            {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            {!isPastDue ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                                Current (Due in {Math.abs(daysDiff)}d)
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-800">
                                Overdue by {daysDiff}d
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {inv.invoiceId && !inv.invoiceId.startsWith('inv_crm_demo') ? (
                              <a
                                href={`https://books.zoho.in/app/60093852869#/invoices/${inv.invoiceId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-indigo-600 hover:text-indigo-900 font-semibold underline text-[11px]"
                              >
                                Open ↗
                              </a>
                            ) : (
                              <span className="text-slate-400 text-[10px]">Demo Record</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-between items-center text-xs">
              <span className="text-slate-500">
                To test overdue status on manual records, adjust the due date in Zoho Books and click Sync Payments.
              </span>
              <button
                onClick={() => setSelectedCustomer(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-medium rounded-lg transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useState, useMemo } from 'react';

function formatCurrency(val, code = 'AED') {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return `${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

export default function OverviewPage({ summary }) {
  const totals = summary?.totals;
  const currency = summary?.activeCurrency || 'AED';
  const rawDeals = summary?.deals || [];

  // Table State: Search, Filter, Pagination
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Status Filter Grouping Logic
  const filteredDeals = useMemo(() => {
    return rawDeals.filter((deal) => {
      // 1. Search Query Match
      const query = searchTerm.toLowerCase().trim();
      const matchesSearch =
        !query ||
        (deal.dealName && deal.dealName.toLowerCase().includes(query)) ||
        (deal.customerName && deal.customerName.toLowerCase().includes(query)) ||
        (deal.crmDealId && String(deal.crmDealId).toLowerCase().includes(query)) ||
        (deal.zohoSalesOrderNumber && deal.zohoSalesOrderNumber.toLowerCase().includes(query));

      if (!matchesSearch) return false;

      // 2. Status Pill Filter Match
      if (statusFilter === 'ALL') return true;
      if (statusFilter === 'SYNCED') {
        return ['SYNCED', 'M1_INVOICED', 'M2_INVOICED', 'M3_INVOICED'].includes(deal.syncStatus);
      }
      if (statusFilter === 'SALES_ORDER') {
        return ['SALES_ORDER_CONFIRMED', 'SALES_ORDER_DRAFT'].includes(deal.syncStatus);
      }
      if (statusFilter === 'PENDING') {
        return deal.syncStatus === 'PENDING';
      }
      if (statusFilter === 'FAILED') {
        return ['FAILED', 'REQUIRES_MANUAL_MATCH'].includes(deal.syncStatus);
      }
      return true;
    });
  }, [rawDeals, searchTerm, statusFilter]);

  // Compute status counts for filter badges
  const statusCounts = useMemo(() => {
    const counts = { ALL: rawDeals.length, SYNCED: 0, SALES_ORDER: 0, PENDING: 0, FAILED: 0 };
    rawDeals.forEach((d) => {
      if (['SYNCED', 'M1_INVOICED', 'M2_INVOICED', 'M3_INVOICED'].includes(d.syncStatus)) {
        counts.SYNCED++;
      } else if (['SALES_ORDER_CONFIRMED', 'SALES_ORDER_DRAFT'].includes(d.syncStatus)) {
        counts.SALES_ORDER++;
      } else if (d.syncStatus === 'PENDING') {
        counts.PENDING++;
      } else if (['FAILED', 'REQUIRES_MANUAL_MATCH'].includes(d.syncStatus)) {
        counts.FAILED++;
      }
    });
    return counts;
  }, [rawDeals]);

  // Pagination Math
  const totalItems = filteredDeals.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedDeals = useMemo(() => {
    const start = (safeCurrentPage - 1) * pageSize;
    return filteredDeals.slice(start, start + pageSize);
  }, [filteredDeals, safeCurrentPage, pageSize]);

  const handleSearchChange = (val) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  const handleStatusFilterChange = (status) => {
    setStatusFilter(status);
    setCurrentPage(1);
  };

  const handlePageSizeChange = (newSize) => {
    setPageSize(Number(newSize));
    setCurrentPage(1);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Notice if unknown payment balances exist */}
      {totals?.unknownBalancesCount > 0 && (
        <div className="bg-amber-50 border-l-4 border-amber-400 p-3 sm:p-4 rounded-md shadow-xs">
          <div className="flex">
            <div className="flex-shrink-0 text-amber-500 font-bold text-base sm:text-lg">⚠️</div>
            <div className="ml-3">
              <p className="text-xs sm:text-sm font-semibold text-amber-800">
                {totals.unknownBalancesCount} deal(s) have PAYMENT_INFO_UNAVAILABLE
              </p>
              <p className="text-[11px] sm:text-xs text-amber-700 mt-0.5">
                Unknown payment balances are strictly preserved as undetermined and never fabricated as zero.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* KPI Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* Card 1: Total Contract Value */}
        <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs">
          <p className="text-[11px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Total Contract Value
          </p>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 mt-1.5 sm:mt-2">
            {formatCurrency(totals?.totalContractValue, currency)}
          </p>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-1">
            Confirmed SOs:{' '}
            <span className="font-semibold text-slate-700">{totals?.confirmedSalesOrdersCount || 0}</span> (
            {formatCurrency(totals?.confirmedSalesOrdersTotal, currency)})
          </p>
        </div>

        {/* Card 2: Total Invoiced */}
        <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs">
          <p className="text-[11px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Total Invoiced
          </p>
          <p className="text-xl sm:text-2xl font-bold text-indigo-600 mt-1.5 sm:mt-2">
            {formatCurrency(totals?.totalInvoiced, currency)}
          </p>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-1">
            Not Yet Invoiced:{' '}
            <span className="font-semibold text-slate-700">{formatCurrency(totals?.amountNotInvoiced, currency)}</span>
          </p>
        </div>

        {/* Card 3: Total Collected */}
        <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs">
          <p className="text-[11px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Total Collected
          </p>
          <p className="text-xl sm:text-2xl font-bold text-emerald-600 mt-1.5 sm:mt-2">
            {formatCurrency(totals?.totalCollected, currency)}
          </p>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-1">
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
        <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs">
          <p className="text-[11px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Invoiced But Unpaid
          </p>
          <p className="text-xl sm:text-2xl font-bold text-amber-600 mt-1.5 sm:mt-2">
            {formatCurrency(totals?.amountInvoicedUnpaid, currency)}
          </p>
          <p className="text-[11px] sm:text-xs text-rose-600 font-semibold mt-1">
            Overdue Outstanding: {formatCurrency(totals?.totalOverdue, currency)}
          </p>
        </div>
      </div>

      {/* Secondary Metric Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] sm:text-xs font-medium text-slate-500">Customers with Balance</p>
            <p className="text-lg sm:text-xl font-bold text-slate-900 mt-0.5 sm:mt-1">
              {totals?.customersWithOutstandingCount || 0}
            </p>
          </div>
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold text-sm sm:text-base">
            👥
          </div>
        </div>

        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] sm:text-xs font-medium text-slate-500">Awaiting Milestone</p>
            <p className="text-lg sm:text-xl font-bold text-slate-900 mt-0.5 sm:mt-1">
              {totals?.dealsAwaitingMilestonesCount || 0}
            </p>
          </div>
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold text-sm sm:text-base">
            ⏳
          </div>
        </div>

        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] sm:text-xs font-medium text-slate-500">Integration Gateway Status</p>
            <p className="text-lg sm:text-xl font-bold text-emerald-600 mt-0.5 sm:mt-1">
              Active &amp; Operational
            </p>
          </div>
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-sm sm:text-base">
            ⚡
          </div>
        </div>
      </div>

      {/* Visual Contract Fulfillment Breakdown */}
      <div className="bg-white p-4 sm:p-6 rounded-xl border border-slate-200 shadow-xs">
        <h3 className="text-xs sm:text-sm font-bold text-slate-900 uppercase tracking-wider mb-3 sm:mb-4">
          Contract Lifecycle & Cash Realization (Gross {currency} Basis)
        </h3>

        <div className="space-y-3 sm:space-y-4">
          <div>
            <div className="flex flex-col sm:flex-row justify-between text-[11px] sm:text-xs font-medium text-slate-600 mb-1.5 gap-1">
              <span className="text-emerald-700 font-semibold">
                Collected: {formatCurrency(totals?.totalCollected, currency)} (
                {totals?.totalContractValue > 0
                  ? ((totals.totalCollected / totals.totalContractValue) * 100).toFixed(1)
                  : 0}
                %)
              </span>
              <span className="text-amber-700 font-semibold">
                Invoiced Unpaid: {formatCurrency(totals?.amountInvoicedUnpaid, currency)}
              </span>
              <span className="text-slate-500">
                Not Yet Invoiced: {formatCurrency(totals?.amountNotInvoiced, currency)}
              </span>
            </div>
            <div className="w-full h-3 sm:h-4 bg-slate-100 rounded-full overflow-hidden flex shadow-inner">
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

      {/* Tracked CRM Deals Table with Search, Filter & Pagination */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        {/* Table Header & Controls Bar */}
        <div className="p-4 sm:p-5 bg-slate-50 border-b border-slate-200 space-y-3 sm:space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span>Tracked CRM Deals</span>
                <span className="text-xs font-semibold px-2 py-0.5 bg-slate-200 text-slate-700 rounded-full">
                  {filteredDeals.length} {filteredDeals.length !== rawDeals.length && `of ${rawDeals.length}`}
                </span>
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-500">
                Deals synchronized or reconciled from HubSpot CRM into the integration ledger.
              </p>
            </div>
            <span className="self-start sm:self-center text-xs font-semibold px-2.5 py-1 bg-white border border-slate-200 text-slate-700 rounded-lg shadow-2xs">
              {summary?.activeCurrency || 'AED'} Ledger
            </span>
          </div>

          {/* Search Input & Status Filters */}
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                placeholder="Search deals by name, customer, ID, or SO..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full pl-9 pr-8 py-1.5 sm:py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-2xs"
              />
              <svg
                className="w-4 h-4 text-slate-400 absolute left-3 top-2.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              {searchTerm && (
                <button
                  onClick={() => handleSearchChange('')}
                  className="absolute right-2.5 top-2.5 text-xs text-slate-400 hover:text-slate-600 font-bold"
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Status Filter Pills (Horizontal Swipe on Mobile) */}
            <div className="overflow-x-auto no-scrollbar py-0.5">
              <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-100 text-xs font-medium whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => handleStatusFilterChange('ALL')}
                  className={`px-2.5 py-1 rounded-md transition ${
                    statusFilter === 'ALL'
                      ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All ({statusCounts.ALL})
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusFilterChange('SYNCED')}
                  className={`px-2.5 py-1 rounded-md transition ${
                    statusFilter === 'SYNCED'
                      ? 'bg-white text-emerald-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Synced ({statusCounts.SYNCED})
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusFilterChange('SALES_ORDER')}
                  className={`px-2.5 py-1 rounded-md transition ${
                    statusFilter === 'SALES_ORDER'
                      ? 'bg-white text-blue-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Sales Order ({statusCounts.SALES_ORDER})
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusFilterChange('PENDING')}
                  className={`px-2.5 py-1 rounded-md transition ${
                    statusFilter === 'PENDING'
                      ? 'bg-white text-amber-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Pending ({statusCounts.PENDING})
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusFilterChange('FAILED')}
                  className={`px-2.5 py-1 rounded-md transition ${
                    statusFilter === 'FAILED'
                      ? 'bg-white text-rose-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Failed ({statusCounts.FAILED})
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Deals Table with Horizontal Scroll */}
        <div className="overflow-x-auto min-w-full">
          {paginatedDeals.length === 0 ? (
            <div className="p-8 sm:p-12 text-center text-xs text-slate-500">
              <p className="font-semibold text-slate-700 text-sm mb-1">No deals match your criteria</p>
              <p>Try adjusting your search query or status filter.</p>
              {(searchTerm || statusFilter !== 'ALL') && (
                <button
                  onClick={() => {
                    setSearchTerm('');
                    setStatusFilter('ALL');
                    setCurrentPage(1);
                  }}
                  className="mt-3 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition"
                >
                  Reset all filters
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-left text-xs text-slate-600 min-w-[720px]">
              <thead className="bg-slate-100 text-slate-700 uppercase font-semibold text-[11px] border-b border-slate-200">
                <tr>
                  <th className="px-4 sm:px-5 py-3">Deal / CRM ID</th>
                  <th className="px-4 sm:px-5 py-3">Customer</th>
                  <th className="px-4 sm:px-5 py-3">Contract Value</th>
                  <th className="px-4 sm:px-5 py-3">Invoiced / Uninvoiced</th>
                  <th className="px-4 sm:px-5 py-3">Sync Status</th>
                  <th className="px-4 sm:px-5 py-3">Sales Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedDeals.map((deal) => {
                  const statusColors = {
                    PENDING: 'bg-amber-100 text-amber-800 border border-amber-200',
                    REQUIRES_MANUAL_MATCH: 'bg-rose-100 text-rose-800 border border-rose-200',
                    SALES_ORDER_DRAFT: 'bg-blue-100 text-blue-800 border border-blue-200',
                    SALES_ORDER_CONFIRMED: 'bg-indigo-100 text-indigo-800 border border-indigo-200',
                    M1_INVOICED: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                    M2_INVOICED: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                    M3_INVOICED: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                    SYNCED: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                    FAILED: 'bg-rose-100 text-rose-800 border border-rose-200'
                  };
                  const badgeClass = statusColors[deal.syncStatus] || 'bg-slate-100 text-slate-800 border border-slate-200';

                  return (
                    <tr key={deal.crmDealId} className="hover:bg-slate-50 transition">
                      <td className="px-4 sm:px-5 py-3">
                        <p className="font-bold text-slate-900">{deal.dealName || 'Unnamed Deal'}</p>
                        <p className="text-[11px] text-slate-400 font-mono">ID: {deal.crmDealId}</p>
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        <p className="font-semibold text-slate-800">{deal.customerName || '—'}</p>
                      </td>
                      <td className="px-4 sm:px-5 py-3 font-bold text-slate-900">
                        {formatCurrency(deal.contractValue, deal.currencyCode || currency)}
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        <p className="text-emerald-600 font-medium">
                          Invoiced: {formatCurrency(deal.totalInvoicedAmount, deal.currencyCode || currency)}
                        </p>
                        <p className="text-slate-400 text-[11px]">
                          Uninvoiced: {formatCurrency(deal.amountNotInvoiced, deal.currencyCode || currency)}
                        </p>
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold ${badgeClass}`}>
                          {deal.syncStatus}
                        </span>
                        {deal.failureReason && (
                          <p className="text-[10px] text-rose-600 mt-1 max-w-xs truncate" title={deal.failureReason}>
                            {deal.failureReason}
                          </p>
                        )}
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        {deal.salesOrderStatus === 'CONFIRMED' ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            {deal.zohoSalesOrderNumber || 'CONFIRMED'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
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

        {/* Pagination Toolbar */}
        {totalItems > 0 && (
          <div className="px-4 sm:px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
            {/* Left: Summary and Page Size Selector */}
            <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-start">
              <span>
                Showing{' '}
                <span className="font-semibold text-slate-900">
                  {totalItems === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1}
                </span>{' '}
                to{' '}
                <span className="font-semibold text-slate-900">
                  {Math.min(safeCurrentPage * pageSize, totalItems)}
                </span>{' '}
                of <span className="font-semibold text-slate-900">{totalItems}</span> deals
              </span>

              <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200">
                <span className="text-slate-500 text-[11px] hidden sm:inline">Per page:</span>
                <select
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(e.target.value)}
                  className="bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>

            {/* Right: Numbered Page Buttons & Navigation */}
            <div className="flex items-center space-x-1.5 w-full sm:w-auto justify-center sm:justify-end">
              <button
                type="button"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none transition"
              >
                Previous
              </button>

              {/* Page Number Buttons */}
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - safeCurrentPage) <= 1)
                .map((p, idx, arr) => {
                  const prev = arr[idx - 1];
                  const showEllipsis = prev && p - prev > 1;

                  return (
                    <React.Fragment key={p}>
                      {showEllipsis && <span className="px-1 text-slate-400">…</span>}
                      <button
                        type="button"
                        onClick={() => setCurrentPage(p)}
                        className={`w-7 h-7 flex items-center justify-center rounded-md text-xs font-semibold transition ${
                          safeCurrentPage === p
                            ? 'bg-indigo-600 text-white shadow-2xs'
                            : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {p}
                      </button>
                    </React.Fragment>
                  );
                })}

              <button
                type="button"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none transition"
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

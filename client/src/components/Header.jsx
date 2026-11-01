import React from 'react';

export default function Header({
  activeTab,
  setActiveTab,
  onRefresh,
  loading
}) {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        {/* Brand & Status */}
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-xs text-sm sm:text-base">
            Z
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight">
                CRM & Zoho Books Gateway
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800">
                <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                Online
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">
              Direct Financial Integration & Operations Dashboard
            </p>
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center px-3.5 py-1.5 border border-transparent shadow-xs text-xs font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none disabled:opacity-50 transition active:scale-95 gap-1.5"
            title="Refresh dashboard data"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs (Smooth horizontal swipe on mobile) */}
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 border-t border-slate-100 overflow-x-auto no-scrollbar">
        <nav className="flex space-x-6 sm:space-x-8 whitespace-nowrap min-w-max">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-1 border-b-2 font-medium text-xs sm:text-sm transition ${
              activeTab === 'overview'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            Financial Overview
          </button>

          <button
            onClick={() => setActiveTab('collections')}
            className={`py-3 px-1 border-b-2 font-medium text-xs sm:text-sm transition ${
              activeTab === 'collections'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            Collections & Aging
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`py-3 px-1 border-b-2 font-medium text-xs sm:text-sm transition ${
              activeTab === 'logs'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            Integration Monitoring & Logs
          </button>

          <button
            onClick={() => setActiveTab('operator')}
            className={`py-3 px-1 border-b-2 font-medium text-xs sm:text-sm transition ${
              activeTab === 'operator'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            Operator Action Center
          </button>
        </nav>
      </div>
    </header>
  );
}

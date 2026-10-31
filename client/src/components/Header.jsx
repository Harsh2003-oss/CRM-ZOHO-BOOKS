import React from 'react';

export default function Header({
  activeTab,
  setActiveTab,
  onOpenKeyModal,
  autoRefresh,
  onToggleAutoRefresh,
  onRefresh,
  loading,
  exceptionCount = 0
}) {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap justify-between items-center gap-4">
        {/* Brand & Status */}
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-md">
            Z
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 leading-tight">CRM & Zoho Books Gateway</h1>
            <p className="text-xs text-slate-500 font-medium">Direct Financial Integration & Operations Dashboard</p>
          </div>
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">
            <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            Online
          </span>
        </div>

        {/* Header Actions */}
        <div className="flex items-center space-x-3">
          <button
            onClick={onOpenKeyModal}
            className="inline-flex items-center px-3 py-1.5 border border-slate-300 shadow-sm text-xs font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 focus:outline-none transition"
          >
            <span className="w-2 h-2 mr-1.5 rounded-full bg-indigo-500"></span>
            Operator Auth
          </button>

          <div className="flex items-center space-x-2 border-l border-slate-200 pl-3">
            <button
              onClick={onToggleAutoRefresh}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                autoRefresh ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Auto-Refresh {autoRefresh ? 'ON' : 'OFF'}
            </button>

            <button
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center px-3 py-1.5 border border-transparent shadow-sm text-xs font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none disabled:opacity-50 transition"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-8 border-t border-slate-100">
        <button
          onClick={() => setActiveTab('overview')}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition ${
            activeTab === 'overview'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          Financial Overview
        </button>

        <button
          onClick={() => setActiveTab('collections')}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition ${
            activeTab === 'collections'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          Collections & Aging
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition ${
            activeTab === 'logs'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          Integration Monitoring & Logs
        </button>

        <button
          onClick={() => setActiveTab('operator')}
          className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 transition ${
            activeTab === 'operator'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <span>Operator Action Center</span>
          {exceptionCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
              {exceptionCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}


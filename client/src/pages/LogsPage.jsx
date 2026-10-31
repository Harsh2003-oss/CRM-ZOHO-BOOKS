import React, { useState } from 'react';

export default function LogsPage({ logsData, eventsData, logsFilter, onFilterChange }) {
  const [selectedLogPayload, setSelectedLogPayload] = useState(null);

  const logs = logsData?.logs || [];
  const queueStats = eventsData?.queueStats;

  return (
    <div className="space-y-6">
      {/* Queue Summary Banner */}
      {queueStats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">RECEIVED (Queue)</p>
            <p className="text-lg font-bold text-sky-600 mt-1">{queueStats.RECEIVED ?? queueStats.received ?? 0}</p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">PROCESSING (Active)</p>
            <p className="text-lg font-bold text-amber-600 mt-1">{queueStats.PROCESSING ?? queueStats.processing ?? 0}</p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">PROCESSED (Completed)</p>
            <p className="text-lg font-bold text-emerald-600 mt-1">{queueStats.PROCESSED ?? queueStats.processed ?? 0}</p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">FAILED (Action Needed)</p>
            <p className="text-lg font-bold text-rose-600 mt-1">{queueStats.FAILED ?? queueStats.failed ?? 0}</p>
          </div>
          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">IGNORED (Filtered)</p>
            <p className="text-lg font-bold text-slate-600 mt-1">{queueStats.IGNORED ?? queueStats.ignored ?? 0}</p>
          </div>
        </div>
      )}

      {/* Filter Controls */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap gap-3 items-center">
        <select
          value={logsFilter.system}
          onChange={(e) => onFilterChange({ ...logsFilter, system: e.target.value })}
          className="px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Systems</option>
          <option value="CRM">HubSpot CRM</option>
          <option value="ZOHO_BOOKS">Zoho Books</option>
        </select>

        <select
          value={logsFilter.isSuccess}
          onChange={(e) => onFilterChange({ ...logsFilter, isSuccess: e.target.value })}
          className="px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Outcomes</option>
          <option value="true">Success (2xx)</option>
          <option value="false">Errors (4xx, 5xx)</option>
        </select>

        <input
          type="text"
          placeholder="Search by Deal ID or Endpoint..."
          value={logsFilter.search}
          onChange={(e) => onFilterChange({ ...logsFilter, search: e.target.value })}
          className="px-3 py-2 border border-slate-300 rounded-lg text-xs flex-1 min-w-[200px] focus:ring-2 focus:ring-indigo-500 outline-none"
        />
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs text-left">
            <thead className="bg-slate-50 text-slate-600 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-3 py-3">System</th>
                <th className="px-3 py-3">Method & Endpoint</th>
                <th className="px-3 py-3">Deal ID</th>
                <th className="px-3 py-3 text-center">Status</th>
                <th className="px-3 py-3 text-right">Latency</th>
                <th className="px-4 py-3">Payload Details (Redacted)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 font-mono">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-4 py-6 text-center text-slate-500 font-sans">
                    No integration audit logs found.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log._id} className="hover:bg-slate-50 transition">
                    <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap font-sans">
                      {new Date(log.timestamp).toLocaleTimeString()}{' '}
                      <span className="text-slate-400">{new Date(log.timestamp).toLocaleDateString()}</span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-sans">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.system === 'CRM' ? 'bg-orange-100 text-orange-800' : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {log.system}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-slate-800">
                      <span className="text-slate-500 mr-1">{log.method}</span>
                      {log.endpoint}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap font-sans">
                      {log.crmDealId || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap font-sans">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.isSuccess ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {log.statusCode}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-600 whitespace-nowrap font-sans">
                      {log.durationMs}ms
                    </td>
                    <td className="px-4 py-2.5 max-w-xs truncate text-slate-500 text-[11px]">
                      <button
                        onClick={() => setSelectedLogPayload(log)}
                        className="text-indigo-600 hover:text-indigo-800 underline mr-2 font-sans"
                      >
                        Inspect
                      </button>
                      <span>{JSON.stringify(log.responseBody || log.requestBody || {}).slice(0, 50)}...</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payload Inspection Modal */}
      {selectedLogPayload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-center border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                Log Details: {selectedLogPayload.method} {selectedLogPayload.endpoint} ({selectedLogPayload.statusCode})
              </h3>
              <button
                onClick={() => setSelectedLogPayload(null)}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold"
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto space-y-3 flex-1 text-xs font-mono">
              <div>
                <p className="font-sans font-bold text-slate-700 mb-1">Request Body (Sanitized):</p>
                <pre className="bg-slate-100 p-3 rounded-lg overflow-x-auto text-slate-800">
                  {JSON.stringify(selectedLogPayload.requestBody, null, 2) || '(empty)'}
                </pre>
              </div>

              <div>
                <p className="font-sans font-bold text-slate-700 mb-1">Response Body (Sanitized):</p>
                <pre className="bg-slate-100 p-3 rounded-lg overflow-x-auto text-slate-800">
                  {JSON.stringify(selectedLogPayload.responseBody, null, 2) || '(empty)'}
                </pre>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-200">
              <button
                onClick={() => setSelectedLogPayload(null)}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md"
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


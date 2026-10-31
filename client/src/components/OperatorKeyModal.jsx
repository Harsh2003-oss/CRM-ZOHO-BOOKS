import React, { useState } from 'react';

export default function OperatorKeyModal({ isOpen, onClose, currentKey, onSave }) {
  const [key, setKey] = useState(currentKey);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <h3 className="text-base font-bold text-slate-900">Operator Authentication Key</h3>
        <p className="text-xs text-slate-500">
          Protected operator actions (retrying events, syncs, and manual ambiguity resolution) require authorization.
        </p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Enter OPERATOR_API_KEY..."
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="flex justify-end space-x-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(key);
              onClose();
            }}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-sm transition"
          >
            Save Key
          </button>
        </div>
      </div>
    </div>
  );
}


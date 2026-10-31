import React from 'react';

export default function ConfirmModal({ modalState, onClose, onConfirm }) {
  if (!modalState.isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <h3 className="text-base font-bold text-slate-900">{modalState.title}</h3>
        <p className="text-sm text-slate-600">{modalState.message}</p>
        <div className="bg-amber-50 p-3 rounded-lg border border-amber-200 text-xs text-amber-800">
          ⚠️ This consequential operation modifies sync and financial state.
        </div>
        <div className="flex justify-end space-x-2 pt-2">
          <button
            disabled={modalState.isExecuting}
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md disabled:opacity-50 transition"
          >
            Cancel
          </button>
          <button
            disabled={modalState.isExecuting}
            onClick={onConfirm}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-sm disabled:opacity-50 flex items-center space-x-1.5 transition"
          >
            {modalState.isExecuting ? (
              <>
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                <span>Executing...</span>
              </>
            ) : (
              <span>Confirm & Execute</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}


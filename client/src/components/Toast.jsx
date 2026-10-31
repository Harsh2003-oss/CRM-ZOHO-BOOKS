import React from 'react';

export default function Toast({ toast }) {
  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium flex items-center space-x-2 transition-all ${
        toast.type === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white'
      }`}
    >
      <span>{toast.message}</span>
    </div>
  );
}


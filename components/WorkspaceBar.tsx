import React, { useState, useRef, useEffect } from 'react';
import { MODULE_PRESETS, getWindowTitle, type AppWindow, type ModulePreset } from '../moduleConfig';
import { PlusIcon, XIcon } from './icons';

interface WorkspaceBarProps {
  windows: AppWindow[];
  activeWindowId: string;
  layoutMode: 'single' | 'split';
  loadedTableCount: number;
  isSyncing: boolean;
  onFocusWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onOpenModuleWindow: (preset: ModulePreset) => void;
  onSetLayoutMode: (mode: 'single' | 'split') => void;
  onRefreshOpenModules: () => void;
}

const CATEGORIES: ModulePreset['category'][] = ['Produksi', 'Logistik', 'Keuangan', 'Laporan', 'Sistem'];

const WorkspaceBar: React.FC<WorkspaceBarProps> = ({
  windows,
  activeWindowId,
  layoutMode,
  loadedTableCount,
  isSyncing,
  onFocusWindow,
  onCloseWindow,
  onOpenModuleWindow,
  onSetLayoutMode,
  onRefreshOpenModules,
}) => {
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const launcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (launcherRef.current && !launcherRef.current.contains(e.target as Node)) {
        setIsLauncherOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsLauncherOpen(false);
    };
    if (isLauncherOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isLauncherOpen]);

  return (
    <div className="mb-4 bg-slate-200/70 backdrop-blur border border-slate-200/90 rounded-2xl px-2.5 pt-2 pb-1.5 shadow-sm flex flex-wrap items-end justify-between gap-2 print:hidden">
      {/* Chrome-style Tab Strip */}
      <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
        {windows.map((win) => {
          const isActive = win.id === activeWindowId;
          const title = getWindowTitle(win);
          return (
            <div
              key={win.id}
              onClick={() => onFocusWindow(win.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && windows.length > 1) {
                  e.preventDefault();
                  onCloseWindow(win.id);
                }
              }}
              className={`group relative flex items-center gap-2 pl-3.5 pr-2 py-2 rounded-t-xl cursor-pointer transition-all text-[10px] font-black uppercase tracking-wider select-none ${
                isActive
                  ? 'bg-white text-slate-900 shadow-sm border border-b-0 border-slate-200/90 z-10'
                  : 'bg-slate-100/70 text-slate-500 border border-transparent hover:bg-white/70 hover:text-slate-800 rounded-xl mb-0.5'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isActive ? 'bg-indigo-600' : 'bg-slate-300 group-hover:bg-slate-400'
                }`}
              />
              <span className="truncate max-w-[170px]">{title}</span>
              {windows.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseWindow(win.id);
                  }}
                  title="Tutup tab"
                  className={`p-0.5 rounded-full transition-colors ${
                    isActive
                      ? 'text-slate-400 hover:text-rose-600 hover:bg-rose-50'
                      : 'text-slate-400 opacity-70 group-hover:opacity-100 hover:text-rose-600 hover:bg-rose-50'
                  }`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Chrome '+' New Tab Launcher */}
        <div className="relative mb-0.5" ref={launcherRef}>
          <button
            type="button"
            onClick={() => setIsLauncherOpen((v) => !v)}
            className="flex items-center justify-center w-7 h-7 rounded-full text-slate-600 hover:bg-white hover:text-indigo-600 hover:shadow-sm transition-all"
            title="Buka tab sub-modul baru (+)"
          >
            <PlusIcon className="h-4 w-4" />
          </button>

          {isLauncherOpen && (
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 bg-white border border-slate-200 rounded-2xl shadow-2xl p-3 z-[250] max-h-[70vh] overflow-y-auto no-scrollbar">
              <div className="flex items-center justify-between px-2 pb-2 mb-2 border-b border-slate-100">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-800">
                  Tab Sub Modul Baru
                </span>
                <button
                  type="button"
                  onClick={() => setIsLauncherOpen(false)}
                  className="text-slate-400 hover:text-slate-700 p-1"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-3">
                {CATEGORIES.map((cat) => {
                  const items = MODULE_PRESETS.filter((p) => p.category === cat);
                  return (
                    <div key={cat}>
                      <p className="px-2 mb-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                        {cat}
                      </p>
                      <div className="grid grid-cols-1 gap-1">
                        {items.map((preset) => {
                          const alreadyOpen = windows.some(
                            (w) =>
                              w.view === preset.view &&
                              (preset.subTab ? (w.subTab || '') === preset.subTab : true)
                          );
                          return (
                            <button
                              key={preset.key}
                              type="button"
                              onClick={() => {
                                onOpenModuleWindow(preset);
                                setIsLauncherOpen(false);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-xl text-[11px] font-bold flex items-center justify-between transition-colors ${
                                alreadyOpen
                                  ? 'bg-indigo-50/70 text-indigo-700 hover:bg-indigo-100'
                                  : 'text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              <span>{preset.label}</span>
                              {alreadyOpen && (
                                <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                                  Tab Aktif
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Utility Controls */}
      <div className="flex items-center gap-2 shrink-0 mb-0.5">
        <span className="hidden md:inline-flex items-center px-2.5 py-1 rounded-lg bg-white/80 border border-slate-200/80 text-[9px] font-bold text-slate-500 uppercase tracking-wider">
          {loadedTableCount} Tabel Aktif
        </span>

        {windows.length > 1 && (
          <div className="hidden lg:flex items-center bg-white/70 p-0.5 rounded-xl border border-slate-200/70">
            <button
              type="button"
              onClick={() => onSetLayoutMode('single')}
              className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${
                layoutMode === 'single' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Tab
            </button>
            <button
              type="button"
              onClick={() => onSetLayoutMode('split')}
              className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all ${
                layoutMode === 'split' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Split ({windows.length})
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onRefreshOpenModules}
          disabled={isSyncing}
          title="Muat ulang data tab yang sedang terbuka"
          className="px-2.5 py-1.5 rounded-xl bg-white/90 hover:bg-white border border-slate-200/80 text-slate-700 text-[9px] font-black uppercase tracking-wider transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin text-indigo-600' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <span className="hidden sm:inline">{isSyncing ? 'Sync...' : 'Refresh'}</span>
        </button>
      </div>
    </div>
  );
};

export default WorkspaceBar;

import React, { useState, useRef, useEffect } from 'react';
import {
  BoxIcon, TruckIcon, DatabaseIcon, DocumentTextIcon,
  ChartBarIcon, BanknotesIcon, LogoutIcon, MenuIcon, XIcon, ChevronDownIcon
} from './icons';
import {
  getSubModulesForView,
  type AppWindow,
  type MainViewId,
  type ModulePreset,
} from '../moduleConfig';

interface OnlineUser {
    user: string;
    location: string;
}

interface HeaderProps {
    activeView: string;
    openWindows: AppWindow[];
    onOpenSubModule: (preset: ModulePreset) => void;
    onLogout: () => void;
    onlineUsers?: OnlineUser[];
    realtimeStatus?: 'connecting' | 'connected' | 'error';
    userRole?: string;
}

const Header: React.FC<HeaderProps> = ({
    activeView,
    openWindows = [],
    onOpenSubModule,
    onLogout,
    onlineUsers = [],
    realtimeStatus = 'connecting',
    userRole = 'admin',
}) => {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [showOnlineList, setShowOnlineList] = useState(false);
    const [openDropdownView, setOpenDropdownView] = useState<MainViewId | null>(null);
    const [expandedMobileView, setExpandedMobileView] = useState<MainViewId | null>(null);
    const navRef = useRef<HTMLElement>(null);

    const navItems: { id: MainViewId; label: string; icon: React.ReactElement; color: string }[] = [
        { id: 'reports', label: 'Dashboard', icon: <ChartBarIcon />, color: 'text-violet-500' },
        { id: 'production', label: 'Produksi', icon: <TruckIcon />, color: 'text-emerald-500' },
        { id: 'logistics', label: 'Logistik', icon: <BoxIcon />, color: 'text-amber-500' },
        { id: 'finance', label: 'Keuangan', icon: <BanknotesIcon />, color: 'text-blue-500' },
        { id: 'database', label: 'Basis Data', icon: <DatabaseIcon />, color: 'text-rose-500' },
        { id: 'dataLogger', label: 'Riwayat', icon: <DocumentTextIcon />, color: 'text-slate-500' },
    ];

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (navRef.current && !navRef.current.contains(e.target as Node)) {
                setOpenDropdownView(null);
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenDropdownView(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, []);

    const isPresetOpen = (preset: ModulePreset) =>
        openWindows.some(
            (w) =>
                w.view === preset.view &&
                (preset.subTab ? (w.subTab || '') === preset.subTab : true)
        );

    const handleDesktopModuleClick = (id: MainViewId) => {
        const subModules = getSubModulesForView(id);
        if (subModules.length <= 1) {
            if (subModules[0]) {
                onOpenSubModule(subModules[0]);
            }
            setOpenDropdownView(null);
            return;
        }
        setOpenDropdownView((prev) => (prev === id ? null : id));
    };

    const handleMobileModuleClick = (id: MainViewId) => {
        const subModules = getSubModulesForView(id);
        if (subModules.length <= 1) {
            if (subModules[0]) {
                onOpenSubModule(subModules[0]);
            }
            setIsMobileMenuOpen(false);
            setExpandedMobileView(null);
            return;
        }
        setExpandedMobileView((prev) => (prev === id ? null : id));
    };

    const statusColors = {
        connecting: 'bg-amber-400',
        connected: 'bg-emerald-500',
        error: 'bg-rose-500'
    };

    const statusLabels = {
        connecting: 'Menghubungkan...',
        connected: 'Realtime Aktif',
        error: 'Realtime Error'
    };

    return (
        <>
            {/* Desktop Top Bar */}
            <header className="fixed top-0 left-0 right-0 z-[100] h-16 bg-white/90 backdrop-blur-xl border-b border-slate-200/60 flex items-center px-6 md:px-10">
                <div className="flex items-center gap-3 shrink-0">
                    <img src="/logo.png" alt="Logo" className="w-9 h-9 object-contain" />
                    <div className="hidden sm:flex flex-col">
                        <span className="font-black text-slate-800 text-xs tracking-tight uppercase">CV DPJ Berkah Unggas</span>
                        <span className="text-[7px] text-slate-400 font-bold tracking-[0.2em] uppercase italic">Rumah Potong Ayam</span>
                    </div>
                </div>

                <nav ref={navRef} className="hidden md:flex flex-1 justify-center px-4">
                    <div className="flex items-center gap-0.5 bg-slate-100 p-1 rounded-xl">
                        {navItems.map((item) => {
                            const subModules = getSubModulesForView(item.id);
                            const hasSubModules = subModules.length > 1;
                            const isActive = activeView === item.id;
                            const isDropdownOpen = openDropdownView === item.id;

                            return (
                                <div key={item.id} className="relative">
                                    <button
                                        type="button"
                                        onClick={() => handleDesktopModuleClick(item.id)}
                                        className={`
                                            flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition-all duration-200
                                            ${isActive || isDropdownOpen
                                                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                                                : 'text-slate-500 hover:text-slate-900 hover:bg-white/50'
                                            }
                                        `}
                                    >
                                        <div className={`${isActive ? item.color : 'text-slate-400'}`}>
                                            {React.cloneElement(item.icon as React.ReactElement<any>, { className: "h-3.5 w-3.5" })}
                                        </div>
                                        <span className="text-[9px] font-black uppercase tracking-widest">{item.label}</span>
                                        {hasSubModules && (
                                            <ChevronDownIcon className={`h-3 w-3 text-slate-400 transition-transform ${isDropdownOpen ? 'rotate-180 text-slate-700' : ''}`} />
                                        )}
                                    </button>

                                    {hasSubModules && isDropdownOpen && (
                                        <div className="absolute left-0 top-full mt-2 w-60 bg-white border border-slate-200/90 shadow-2xl rounded-2xl p-2 z-[260]">
                                            <p className="px-2.5 py-1 text-[8px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 mb-1">
                                                Pilih Sub Modul {item.label}
                                            </p>
                                            <div className="space-y-0.5">
                                                {subModules.map((preset) => {
                                                    const alreadyOpen = isPresetOpen(preset);
                                                    return (
                                                        <button
                                                            key={preset.key}
                                                            type="button"
                                                            onClick={() => {
                                                                onOpenSubModule(preset);
                                                                setOpenDropdownView(null);
                                                            }}
                                                            className={`w-full text-left px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-between transition-colors ${
                                                                alreadyOpen
                                                                    ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
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
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </nav>

                <div className="flex items-center gap-3 ml-auto md:ml-0">
                    <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 rounded-full border border-slate-100">
                        <div className={`w-1.5 h-1.5 rounded-full ${statusColors[realtimeStatus]} ${realtimeStatus === 'connected' ? 'animate-pulse' : ''}`} />
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-tighter">{statusLabels[realtimeStatus]}</span>
                    </div>

                    <div className="relative">
                        <button
                          onMouseEnter={() => setShowOnlineList(true)}
                          onMouseLeave={() => setShowOnlineList(false)}
                          onClick={() => setShowOnlineList(!showOnlineList)}
                          className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 rounded-full border border-emerald-100 hover:bg-emerald-100 transition-colors"
                        >
                            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                            <span className="text-[10px] font-black text-emerald-600 uppercase tracking-tighter">{onlineUsers.length} Online</span>
                        </button>

                        {showOnlineList && onlineUsers.length > 0 && (
                            <div className="absolute top-full right-0 mt-2 w-48 bg-white border border-slate-100 shadow-xl rounded-2xl py-3 px-4 z-[200]">
                                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-50 pb-1">User Aktif</p>
                                <ul className="space-y-2">
                                    {onlineUsers.map((item, i) => (
                                        <li key={i} className="flex flex-col gap-0.5">
                                            <div className="flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                                                <span className="text-[10px] font-bold text-slate-700 capitalize">{item.user}</span>
                                            </div>
                                            <span className="text-[7px] font-black text-slate-400 uppercase ml-3.5 tracking-tighter bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100 w-fit leading-none">{item.location}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    <div className="hidden lg:flex flex-col items-end mr-2">
                        <span className="text-[7px] font-black text-indigo-400 uppercase tracking-widest leading-none mb-0.5">Akses Login</span>
                        <span className="text-[10px] font-black text-slate-700 uppercase">{userRole || 'admin'}</span>
                    </div>
                    <button onClick={onLogout} className="p-2 text-slate-400 hover:text-red-600 transition-colors"><LogoutIcon /></button>
                    <button onClick={() => setIsMobileMenuOpen(true)} className="md:hidden p-2 text-slate-600"><MenuIcon /></button>
                </div>
            </header>

            {/* Mobile Sidebar */}
            <div className={`fixed inset-0 z-[110] md:hidden transition-all duration-300 ${isMobileMenuOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>
                <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
                <div className={`absolute top-0 right-0 h-full w-72 bg-white shadow-2xl transition-transform duration-300 transform ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}>
                    <div className="p-6 h-full flex flex-col">
                        <div className="flex items-center justify-between mb-6">
                            <img src="/logo.png" alt="Logo" className="w-10 h-10" />
                            <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 text-slate-400"><XIcon className="h-5 w-5" /></button>
                        </div>
                        <div className="flex-1 space-y-1 overflow-y-auto no-scrollbar">
                            {navItems.map((item) => {
                                const subModules = getSubModulesForView(item.id);
                                const hasSubModules = subModules.length > 1;
                                const isExpanded = expandedMobileView === item.id;
                                const isActive = activeView === item.id;

                                return (
                                    <div key={item.id} className="space-y-1">
                                        <button
                                            type="button"
                                            onClick={() => handleMobileModuleClick(item.id)}
                                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all ${
                                                isActive ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'text-slate-600 hover:bg-slate-50'
                                            }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                {React.cloneElement(item.icon as React.ReactElement<any>, { className: "h-4 w-4" })}
                                                <span className="text-[10px] font-black uppercase tracking-widest">{item.label}</span>
                                            </div>
                                            {hasSubModules && (
                                                <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                            )}
                                        </button>

                                        {hasSubModules && isExpanded && (
                                            <div className="pl-4 pr-1 py-1 space-y-1 bg-slate-50 rounded-xl border border-slate-100">
                                                {subModules.map((preset) => {
                                                    const alreadyOpen = isPresetOpen(preset);
                                                    return (
                                                        <button
                                                            key={preset.key}
                                                            type="button"
                                                            onClick={() => {
                                                                onOpenSubModule(preset);
                                                                setIsMobileMenuOpen(false);
                                                                setExpandedMobileView(null);
                                                            }}
                                                            className={`w-full text-left px-3 py-2 rounded-lg text-[10px] font-bold flex items-center justify-between ${
                                                                alreadyOpen ? 'bg-indigo-100/70 text-indigo-700' : 'text-slate-600 hover:bg-white'
                                                            }`}
                                                        >
                                                            <span>{preset.label}</span>
                                                            {alreadyOpen && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <button onClick={onLogout} className="mt-4 w-full flex items-center gap-4 px-4 py-3.5 rounded-xl bg-red-50 text-red-600 font-black text-[10px] uppercase tracking-widest"><LogoutIcon /> Keluar</button>
                    </div>
                </div>
            </div>
        </>
    );
};

export default Header;
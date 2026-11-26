import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Header from './components/Header';
import WorkspaceBar from './components/WorkspaceBar';
import ProductionForm from './components/ProductionForm';
import StockView from './components/StockView';
import AllocationForm from './components/AllocationForm';
import InvoiceForm from './components/InvoiceForm';
import Login from './components/Login';
import DatabaseManagement from './components/DatabaseManagement';
import DeliveryOrderList from './components/DeliveryOrderList';
import DeliveryOrderDetail from './components/DeliveryOrderDetail';
import InvoiceList from './components/InvoiceList';
import InvoiceDetail from './components/InvoiceDetail';
import StockOpnameForm from './components/StockOpnameForm';
import StockHistoryView from './components/StockHistoryView';
import TradingHistoryView from './components/TradingHistoryView';
import DisposalHistoryView from './components/DisposalHistoryView';
import TradingPurchaseForm from './components/TradingPurchaseForm';
import StockDisposalForm from './components/StockDisposalForm';
import LedgerView from './components/LedgerView';
import ExpenseView from './components/ExpenseView';
import ExpenseForm from './components/ExpenseForm';
import SalaryView from './components/SalaryView';
import SalaryForm from './components/SalaryForm';
import CoopPriceForm from './components/CoopPriceForm';
import DashboardReport from './components/DashboardReport';
import ProductionReport from './components/ProductionReport';
import BelanjaLBReport from './components/BelanjaLBReport';
import HPPView from './components/HPPView';
import StockValueReport from './components/StockValueReport';
import ProfitLossView from './components/ProfitLossView';
import SalesReportHistory from './components/SalesReportHistory';
import DailyRecapReport from './components/DailyRecapReport';
import ActivityHistoryView from './components/ActivityHistoryView';
import ProductionEditModal from './components/ProductionEditModal';
import ManualSJForm from './components/ManualSJForm';
import ManualInvoiceForm from './components/ManualInvoiceForm';
import EndingInventoryForm from './components/EndingInventoryForm';
import { TrashIcon, XIcon } from './components/icons';
import { db, checkBackendHealth, hasAuthToken, clearAuthToken, setOnUnauthorized } from './apiClient';
import { CACHED_LARGE_TABLES, type CachedTableName } from './idbCache';
import {
    MODULE_PRESETS,
    getDefaultSubTab,
    getTablesForWindow,
    getWindowTitle,
    MUTABLE_LARGE_TABLES,
    type AppWindow,
    type DatabaseSubTab,
    type MainViewId,
    type ModulePreset,
} from './moduleConfig';
import { CHICKEN_PARTS, sortChickenParts } from './constants';
import type {
    StockItem, Coop, Customer, MasterItem, Invoice, DeliveryOrder,
    SupabaseInvoice, ExpenseRecord, SalaryRecord, LedgerEntry,
    StockLog, SupabaseProductionLog, TradingPurchaseRecord, StockDisposalRecord, AllocationItem
} from './types';

const INITIAL_WINDOW: AppWindow = {
    id: 'win-production',
    view: 'production',
};

const EMPTY_RAW_DATA = {
    coops: [] as Coop[],
    customers: [] as Customer[],
    plates: [] as string[],
    masterItems: [] as MasterItem[],
    currentStock: [] as any[],
    deliveryOrders: [] as any[],
    invoices: [] as SupabaseInvoice[],
    expenses: [] as any[],
    salaries: [] as any[],
    ledger: [] as any[],
    stockLogs: [] as any[],
    productionLogs: [] as SupabaseProductionLog[],
    tradingPurchases: [] as TradingPurchaseRecord[],
    stockDisposals: [] as StockDisposalRecord[],
    earlyStock: [] as any[],
};

type LiveStatusSnapshot = {
    onlineUsers: { user: string; location: string }[];
    realtimeStatus: 'connecting' | 'connected' | 'error';
};

interface LiveStatusHeaderProps {
    statusRef: React.MutableRefObject<LiveStatusSnapshot>;
    listenersRef: React.MutableRefObject<Set<(next: LiveStatusSnapshot) => void>>;
    activeView: string;
    openWindows: AppWindow[];
    onOpenSubModule: (preset: ModulePreset) => void;
    onLogout: () => void;
    userRole: string;
}

const LiveStatusHeader: React.FC<LiveStatusHeaderProps> = React.memo(({
    statusRef,
    listenersRef,
    activeView,
    openWindows,
    onOpenSubModule,
    onLogout,
    userRole,
}) => {
    const [status, setStatus] = useState<LiveStatusSnapshot>(() => statusRef.current);

    useEffect(() => {
        setStatus(statusRef.current);
        const listener = (next: LiveStatusSnapshot) => setStatus(next);
        listenersRef.current.add(listener);
        return () => {
            listenersRef.current.delete(listener);
        };
    }, [statusRef, listenersRef]);

    return (
        <Header
            activeView={activeView}
            openWindows={openWindows}
            onOpenSubModule={onOpenSubModule}
            onLogout={onLogout}
            onlineUsers={status.onlineUsers}
            realtimeStatus={status.realtimeStatus}
            userRole={userRole}
        />
    );
});

const App: React.FC = () => {
    const [isAuthenticated, setIsAuthenticated] = useState(() => hasAuthToken());
    const [currentUserName, setCurrentUserName] = useState('');
    const [userRole, setUserRole] = useState('admin');
    const liveStatusRef = useRef<LiveStatusSnapshot>({
        onlineUsers: [],
        realtimeStatus: 'connecting',
    });
    const liveStatusListenersRef = useRef<Set<(next: LiveStatusSnapshot) => void>>(new Set());

    const updateLiveStatus = useCallback((patch: Partial<LiveStatusSnapshot>) => {
        const next: LiveStatusSnapshot = {
            ...liveStatusRef.current,
            ...patch,
        };
        liveStatusRef.current = next;
        liveStatusListenersRef.current.forEach((listener) => listener(next));
    }, []);

    // Always boot at Input Produksi ('production') so heavy Dashboard data isn't pulled on startup
    const [windows, setWindows] = useState<AppWindow[]>([INITIAL_WINDOW]);
    const [activeWindowId, setActiveWindowId] = useState<string>(INITIAL_WINDOW.id);
    const [layoutMode, setLayoutMode] = useState<'single' | 'split'>('single');

    const activeWindow = useMemo(
        () => windows.find(w => w.id === activeWindowId) || windows[0],
        [windows, activeWindowId]
    );
    const activeView = activeWindow.view;

    const updateWindow = useCallback((windowId: string, patch: Partial<AppWindow>) => {
        setWindows(prev => prev.map(w => (w.id === windowId ? { ...w, ...patch } : w)));
    }, []);

    const handleOpenModuleWindow = useCallback((preset: ModulePreset) => {
        const existing = windows.find(
            w => w.view === preset.view && (preset.subTab ? (w.subTab || getDefaultSubTab(w.view)) === preset.subTab : true)
        );
        if (existing) {
            setActiveWindowId(existing.id);
            return;
        }
        const newWin: AppWindow = {
            id: `win-${preset.key}-${Date.now()}`,
            view: preset.view,
            subTab: preset.subTab ?? getDefaultSubTab(preset.view),
            stockSubView: 'main',
            dbSubTab: 'coops',
        };
        setWindows(prev => [...prev, newWin]);
        setActiveWindowId(newWin.id);
    }, [windows]);

    const openOrFocusPreset = useCallback((view: MainViewId, subTab?: string) => {
        const matched = MODULE_PRESETS.find(
            p => p.view === view && (subTab ? p.subTab === subTab : true)
        );
        if (matched) {
            handleOpenModuleWindow(matched);
            return;
        }
        handleOpenModuleWindow({
            key: subTab ? `${view}:${subTab}` : view,
            category: 'Sistem',
            label: subTab || view,
            view,
            subTab,
        });
    }, [handleOpenModuleWindow]);

    const handleCloseWindow = useCallback((winId: string) => {
        setWindows(prev => {
            if (prev.length <= 1) return prev;
            const idx = prev.findIndex(w => w.id === winId);
            const next = prev.filter(w => w.id !== winId);
            if (activeWindowId === winId && next.length > 0) {
                const fallback = next[Math.max(0, idx - 1)] || next[0];
                setActiveWindowId(fallback.id);
            }
            if (next.length <= 1) {
                setLayoutMode('single');
            }
            return next;
        });
    }, [activeWindowId]);

    const getCurrentLocation = useCallback(() => {
        if (windows.length > 1) {
            return `${getWindowTitle(activeWindow)} (+${windows.length - 1})`;
        }
        return getWindowTitle(activeWindow);
    }, [activeWindow, windows.length]);

    const [isLoading, setIsLoading] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [dbError, setDbError] = useState<string | null>(null);
    const [loadedTableCount, setLoadedTableCount] = useState(0);

    const [coops, setCoops] = useState<Coop[]>([]);
    const [licensePlates, setLicensePlates] = useState<string[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [masterItems, setMasterItems] = useState<MasterItem[]>(CHICKEN_PARTS.map(name => ({ name })));
    const [stock, setStock] = useState<StockItem[]>([]);
    const [deliveryOrders, setDeliveryOrders] = useState<DeliveryOrder[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
    const [salaries, setSalaries] = useState<SalaryRecord[]>([]);
    const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
    const [stockLogs, setStockLogs] = useState<StockLog[]>([]);
    const [customerDebts, setCustomerDebts] = useState<{ [key: string]: number }>({});
    const [productionLogs, setProductionLogs] = useState<any[]>([]);
    const [pendingLogs, setPendingLogs] = useState<any[]>([]);
    const [tradingPurchases, setTradingPurchases] = useState<TradingPurchaseRecord[]>([]);
    const [stockDisposals, setStockDisposals] = useState<StockDisposalRecord[]>([]);
    const [earlyStock, setEarlyStock] = useState<any[]>([]);
    const [isAllocating, setIsAllocating] = useState(false);
    const [isTradingPurchaseOpen, setIsTradingPurchaseOpen] = useState(false);
    const [isDisposalOpen, setIsDisposalOpen] = useState(false);
    const [tradingPurchaseToEdit, setTradingPurchaseToEdit] = useState<TradingPurchaseRecord | null>(null);
    const [disposalToEdit, setDisposalToEdit] = useState<StockDisposalRecord | null>(null);
    const [isOpnameOpen, setIsOpnameOpen] = useState(false);
    const [isAddingExpense, setIsAddingExpense] = useState(false);
    const [isAddingSalary, setIsAddingSalary] = useState(false);
    const [salaryImportData, setSalaryImportData] = useState<Omit<SalaryRecord, 'id'>[] | null>(null);
    const [isManualSJOpen, setIsManualSJOpen] = useState(false);
    const [isManualInvoiceOpen, setIsManualInvoiceOpen] = useState(false);
    const [isEndingInventoryOpen, setIsEndingInventoryOpen] = useState(false);

    const [selectedSJ, setSelectedSJ] = useState<DeliveryOrder | null>(null);
    const [selectedInv, setSelectedInv] = useState<Invoice | null>(null);
    const [orderToInvoice, setOrderToInvoice] = useState<DeliveryOrder | null>(null);
    const [invoiceToEdit, setInvoiceToEdit] = useState<Invoice | null>(null);
    const [productionToEdit, setProductionToEdit] = useState<any | null>(null);
    const [pendingInvoiceOrder, setPendingInvoiceOrder] = useState<DeliveryOrder | null>(null);

    const inFlightFetchRef = useRef<Promise<void> | null>(null);
    const queuedFetchRef = useRef<{ tables: Set<string>; silent: boolean; forceFull: boolean } | null>(null);
    const loadedTablesRef = useRef<Set<string>>(new Set());
    const reconciledTablesRef = useRef<Set<string>>(new Set());
    const requiredTablesRef = useRef<Set<string>>(new Set());

    const rawDataRef = useRef({ ...EMPTY_RAW_DATA });

    const hydrateMasterAndStock = useCallback((rawMasterItems: MasterItem[], rawCurrentStock: any[]) => {
        const finalMasterItems = (rawMasterItems && rawMasterItems.length > 0 ? rawMasterItems : CHICKEN_PARTS.map(name => ({ name })))
            .slice()
            .sort((a: MasterItem, b: MasterItem) => sortChickenParts(a.name, b.name));
        setMasterItems(finalMasterItems);
        const stockMap = new Map((rawCurrentStock || []).map((s: any) => [s.item_name, Number(s.quantity) || 0]));
        setStock(finalMasterItems.map((item: { name: string }) => ({ name: item.name, quantity: stockMap.get(item.name) || 0 })));
    }, []);

    const hydrateProduction = useCallback((rawProdLogs: SupabaseProductionLog[]) => {
        const aggregatedProd: any[] = [];
        const aggregatedPending: any[] = [];
        const prodMap = new Map<string, any>();
        const pendingMap = new Map<string, any>();

        for (const row of rawProdLogs || []) {
            const date = new Date(row.tanggal_produksi);
            const dateMs = date.getTime();
            const dateOnly = row.tanggal_produksi || date.toISOString().slice(0, 10);
            const truckNumber = Number(row.mobil);
            const key = `${dateOnly}-${truckNumber}`;
            const itemName = row.item_name;
            const itemQty = Number(row.qty);
            const targetMap = row.is_applied ? prodMap : pendingMap;
            const targetList = row.is_applied ? aggregatedProd : aggregatedPending;

            let agg = targetMap.get(key);
            if (!agg) {
                agg = {
                    id: row.id,
                    date,
                    dateMs,
                    dateStr: row.tanggal_produksi,
                    truckNumber,
                    coopName: row.nama_kandang,
                    driver: row.driver,
                    initialEkor: Number(row.ekor),
                    initialKg: Number(row.kg),
                    pricePerKg: Number(row.harga_beli_kg || 0),
                    mortality: Number(row.kematian_ekor),
                    mortalityKg: Number(row.kematian_kg),
                    isApplied: row.is_applied,
                    licensePlate: row.plat,
                    items: {},
                };
                targetMap.set(key, agg);
                targetList.push(agg);
            }
            agg.items[itemName] = (agg.items[itemName] || 0) + itemQty;
        }

        setProductionLogs(aggregatedProd);
        setPendingLogs(aggregatedPending);
    }, []);

    const hydrateInvoicesLedgerAndDOs = useCallback((
        rawCustomers: Customer[],
        rawInvoices: SupabaseInvoice[],
        rawLedger: any[],
        rawDeliveryOrders: any[]
    ) => {
        const mappedLedger: LedgerEntry[] = (rawLedger || []).map((l: any) => {
            const date = new Date(l.tanggal);
            const tsStr = l.timestamp || '';
            const tsMs = tsStr ? Date.parse(tsStr) : date.getTime();
            return {
                ...l,
                id: l.id,
                date,
                dateMs: date.getTime(),
                timestamp: tsStr,
                timestampMs: isNaN(tsMs) ? date.getTime() : tsMs,
                debit: Number(l.debit) || 0,
                credit: Number(l.credit) || 0,
                balance: Number(l.balance) || 0,
                customerId: l.customer_id,
                paymentMethod: l.metode_bayar,
                paymentProof: l.bukti_bayar,
            };
        });
        setLedgerEntries(mappedLedger);

        const customerAddressMap = new Map((rawCustomers || []).map((c: any) => [c.name, c.address || '']) as Array<[string, string]>);

        const sjMap = new Map<string, DeliveryOrder>();
        for (const row of rawDeliveryOrders || []) {
            let sj = sjMap.get(row.nomor_sj);
            if (!sj) {
                const date = new Date(row.tanggal);
                sj = {
                    id: row.nomor_sj,
                    date,
                    dateMs: date.getTime(),
                    customer: row.customer,
                    customerAddress: customerAddressMap.get(row.customer) || '',
                    items: [],
                    receivedItems: [],
                    rejectedItems: [],
                    status: 'pending',
                };
                sjMap.set(row.nomor_sj, sj);
            }
            const qtySent = Number(row.qty_kirim) || 0;
            const qtyReceived = Number(row.qty_diterima) || 0;
            const qtyRetur = Number(row.retur) || 0;
            const existingItem = sj.items.find(i => i.name === row.nama_item);
            if (existingItem) existingItem.quantity += qtySent; else sj.items.push({ name: row.nama_item, quantity: qtySent });
            if (qtyReceived > 0) {
                const existingReceived = sj.receivedItems?.find(ri => ri.name === row.nama_item);
                if (existingReceived) existingReceived.quantity += qtyReceived; else sj.receivedItems?.push({ name: row.nama_item, quantity: qtyReceived });
            }
            if (qtyRetur > 0) {
                const existingRejected = sj.rejectedItems?.find(ri => ri.name === row.nama_item);
                if (existingRejected) existingRejected.quantity += qtyRetur; else sj.rejectedItems?.push({ name: row.nama_item, quantity: qtyRetur });
            }
            if (sj.receivedItems && sj.receivedItems.length > 0) sj.status = 'received';
        }

        const invMap = new Map<string, Invoice>();
        for (const row of rawInvoices || []) {
            let inv = invMap.get(row.nomor_invoice);
            if (!inv) {
                const date = new Date(row.tanggal);
                const tsStr = row.timestamp || '';
                const tsMs = tsStr ? Date.parse(tsStr) : date.getTime();
                inv = {
                    id: row.nomor_invoice,
                    date,
                    dateMs: date.getTime(),
                    timestamp: tsStr,
                    timestampMs: isNaN(tsMs) ? date.getTime() : tsMs,
                    deliveryOrderId: row.nomor_sj || '',
                    customer: row.customer || '',
                    customerAddress: customerAddressMap.get(row.customer || '') || '',
                    itemName: '',
                    items: [],
                    subtotal: 0,
                    previousDebt: 0,
                    totalAmount: 0,
                    transfer: 0,
                    cash: 0,
                    amountPaid: 0,
                    newDebt: 0,
                    qtyDiterima: 0,
                    keterangan: row.keterangan || '',
                    status: row.invoice_status || 'Unpaid',
                    paymentMethod: '-',
                };
                invMap.set(row.nomor_invoice, inv);
            }
            const valTotal = Number(row.total) || 0;
            const valQty = Number(row.qty_diterima) || 0;
            const valHarga = Number(row.harga) || 0;
            const existingItem = inv.items.find(i => i.name === row.item_name);
            if (existingItem) {
                existingItem.quantity += valQty;
                existingItem.total += valTotal;
                existingItem.price = valHarga;
            } else {
                inv.items.push({ name: row.item_name, quantity: valQty, price: valHarga, total: valTotal });
            }
            inv.transfer = Math.max(inv.transfer, Number(row.transfer) || 0);
            inv.cash = Math.max(inv.cash, Number(row.cash) || 0);
            inv.amountPaid = inv.transfer + inv.cash;
            inv.paymentMethod = (inv.transfer > 0 && inv.cash > 0) ? 'Transfer & Cash' : inv.transfer > 0 ? 'Transfer' : inv.cash > 0 ? 'Cash' : '-';
            inv.subtotal += valTotal;
            inv.qtyDiterima += valQty;
        }

        const allInvoices = Array.from(invMap.values());

        const customerInvoicesMap = new Map<string, Invoice[]>();
        const sjToInvIdMap = new Map<string, string>();
        for (const inv of allInvoices) {
            if (!customerInvoicesMap.has(inv.customer)) customerInvoicesMap.set(inv.customer, []);
            customerInvoicesMap.get(inv.customer)!.push(inv);
            if (inv.deliveryOrderId) {
                for (const sjPart of inv.deliveryOrderId.split(', ')) {
                    if (sjPart && !sjToInvIdMap.has(sjPart)) sjToInvIdMap.set(sjPart, inv.id);
                }
            }
        }

        const customerLedgerMap = new Map<string, LedgerEntry[]>();
        for (const l of mappedLedger) {
            if (!customerLedgerMap.has(l.customerId)) customerLedgerMap.set(l.customerId, []);
            customerLedgerMap.get(l.customerId)!.push(l);
        }

        const debts: { [key: string]: number } = {};
        for (const c of rawCustomers || []) {
            const customerInvoices = customerInvoicesMap.get(c.name) || [];
            const customerLedger = customerLedgerMap.get(c.name) || [];
            const events: { type: 'inv' | 'led'; dateMs: number; ts: string; ref: any }[] = [];
            for (const inv of customerInvoices) {
                events.push({ type: 'inv', dateMs: inv.dateMs ?? inv.date.getTime(), ts: inv.timestamp || '', ref: inv });
            }
            for (const l of customerLedger) {
                events.push({ type: 'led', dateMs: l.dateMs ?? l.date.getTime(), ts: l.timestamp || '', ref: l });
            }
            events.sort((a, b) => a.dateMs - b.dateMs || a.ts.localeCompare(b.ts));
            let runningBalance = 0;
            for (const event of events) {
                if (event.type === 'inv') {
                    const inv = event.ref;
                    inv.previousDebt = runningBalance;
                    inv.totalAmount = inv.subtotal + inv.previousDebt;
                    inv.newDebt = inv.totalAmount - inv.amountPaid;
                    runningBalance = inv.newDebt;
                } else {
                    const l = event.ref;
                    runningBalance += (Number(l.debit) || 0) - (Number(l.credit) || 0);
                }
            }
            debts[c.name] = Math.max(0, runningBalance);
        }

        setInvoices(allInvoices);
        setCustomerDebts(debts);

        const allSJs = Array.from(sjMap.values());
        for (const sj of allSJs) {
            const associatedInvId = sjToInvIdMap.get(sj.id);
            if (associatedInvId) sj.invoiceId = associatedInvId;
        }
        setDeliveryOrders(allSJs);
    }, []);

    const applyTableSlice = useCallback((tableName: string, data: any[]) => {
        const raw = rawDataRef.current;
        switch (tableName) {
            case 'master_coops':
                raw.coops = data;
                setCoops(data);
                break;
            case 'master_customers':
                raw.customers = data;
                setCustomers(data);
                hydrateInvoicesLedgerAndDOs(data, raw.invoices, raw.ledger, raw.deliveryOrders);
                break;
            case 'master_plates':
                raw.plates = data;
                setLicensePlates(data);
                break;
            case 'master_items':
                raw.masterItems = data;
                hydrateMasterAndStock(data, raw.currentStock);
                break;
            case 'current_stock':
                raw.currentStock = data;
                hydrateMasterAndStock(raw.masterItems, data);
                break;
            case 'delivery_orders':
                raw.deliveryOrders = data;
                hydrateInvoicesLedgerAndDOs(raw.customers, raw.invoices, raw.ledger, data);
                break;
            case 'invoices':
                raw.invoices = data;
                hydrateInvoicesLedgerAndDOs(raw.customers, data, raw.ledger, raw.deliveryOrders);
                break;
            case 'ledger_entries':
                raw.ledger = data;
                hydrateInvoicesLedgerAndDOs(raw.customers, raw.invoices, data, raw.deliveryOrders);
                break;
            case 'expenses':
                raw.expenses = data;
                setExpenses((data || []).map((e: any) => {
                    const date = e.tanggal ? new Date(e.tanggal) : new Date();
                    return {
                        id: e.id,
                        date,
                        dateMs: date.getTime(),
                        category: e.kategori || 'N/A',
                        amount: Number(e.jumlah || 0),
                        description: e.description || '',
                        proofImage: e.proof_image_url,
                    };
                }));
                break;
            case 'salaries':
                raw.salaries = data;
                setSalaries((data || []).map((s: any) => {
                    const date = s.tanggal ? new Date(s.tanggal) : new Date();
                    return {
                        id: s.id,
                        date,
                        dateMs: date.getTime(),
                        employeeName: s.nama_karyawan || 'N/A',
                        dailyRate: Number(s.gaji_harian || 0),
                        daysWorked: Number(s.hari_kerja || 0),
                        cashBon: Number(s.kasbon || 0),
                        totalSalary: Number(s.total_gaji || 0),
                        notes: s.catatan || '',
                        role: s.role || '',
                    };
                }));
                break;
            case 'stock_logs':
                raw.stockLogs = data;
                setStockLogs((data || []).map((l: any) => {
                    const timestamp = new Date(l.timestamp);
                    return {
                        id: l.id,
                        timestamp,
                        timestampMs: timestamp.getTime(),
                        type: l.tipe as any,
                        itemName: l.item_name,
                        stockBefore: Number(l.stok_awal) || 0,
                        change: Number(l.perubahan) || 0,
                        stockAfter: Number(l.stok_akhir) || 0,
                        notes: l.keterangan || '',
                    };
                }));
                break;
            case 'production_logs':
                raw.productionLogs = data;
                hydrateProduction(data);
                break;
            case 'trading_purchases':
                raw.tradingPurchases = data;
                setTradingPurchases((data || []).map((t: any) => ({
                    ...t,
                    timestampMs: t.timestamp ? Date.parse(t.timestamp) : (t.tanggal ? Date.parse(t.tanggal) : 0),
                })));
                break;
            case 'stock_disposals':
                raw.stockDisposals = data;
                setStockDisposals((data || []).map((d: any) => ({
                    ...d,
                    timestampMs: d.timestamp ? Date.parse(d.timestamp) : (d.tanggal ? Date.parse(d.tanggal) : 0),
                })));
                break;
            case 'early_stock':
                raw.earlyStock = data;
                setEarlyStock(data || []);
                break;
            default:
                break;
        }
    }, [hydrateInvoicesLedgerAndDOs, hydrateMasterAndStock, hydrateProduction]);

    // Exact union of Supabase tables needed ONLY by currently open windows & active modals
    const requiredTablesList = useMemo(() => {
        const set = new Set<string>();
        for (const win of windows) {
            for (const tbl of getTablesForWindow(win)) {
                set.add(tbl);
            }
        }
        if (isAllocating) {
            ['master_items', 'current_stock', 'master_customers', 'delivery_orders'].forEach(t => set.add(t));
        }
        if (isTradingPurchaseOpen) {
            ['trading_purchases', 'master_items', 'current_stock'].forEach(t => set.add(t));
        }
        if (isDisposalOpen) {
            ['stock_disposals', 'master_items', 'current_stock'].forEach(t => set.add(t));
        }
        if (isOpnameOpen) {
            ['stock_logs', 'current_stock', 'master_items'].forEach(t => set.add(t));
        }
        if (isManualSJOpen || isManualInvoiceOpen) {
            ['master_customers', 'master_items'].forEach(t => set.add(t));
        }
        if (isEndingInventoryOpen) {
            set.add('early_stock');
        }
        if (selectedSJ || orderToInvoice || invoiceToEdit || selectedInv || pendingInvoiceOrder) {
            ['delivery_orders', 'invoices', 'ledger_entries', 'master_customers', 'master_items'].forEach(t => set.add(t));
        }
        if (productionToEdit) {
            ['master_coops', 'master_plates', 'master_items', 'production_logs'].forEach(t => set.add(t));
        }
        return Array.from(set);
    }, [
        windows,
        isAllocating,
        isTradingPurchaseOpen,
        isDisposalOpen,
        isOpnameOpen,
        isManualSJOpen,
        isManualInvoiceOpen,
        isEndingInventoryOpen,
        selectedSJ,
        orderToInvoice,
        invoiceToEdit,
        selectedInv,
        pendingInvoiceOrder,
        productionToEdit,
    ]);

    useEffect(() => {
        requiredTablesRef.current = new Set(requiredTablesList);
    }, [requiredTablesList]);

    const fetchTablesScoped = useCallback((tablesToFetch: string[], isSilent: boolean = false, forceFull: boolean = false): Promise<void> => {
        const uniqueTables = Array.from(new Set(tablesToFetch)).filter(Boolean);
        if (uniqueTables.length === 0) return Promise.resolve();

        if (inFlightFetchRef.current) {
            const prev = queuedFetchRef.current;
            const merged = new Set(prev ? Array.from(prev.tables) : []);
            uniqueTables.forEach(t => merged.add(t));
            queuedFetchRef.current = {
                tables: merged,
                silent: prev ? (prev.silent && isSilent) : isSilent,
                forceFull: prev ? (prev.forceFull || forceFull) : forceFull,
            };
            return inFlightFetchRef.current;
        }

        const promise = (async () => {
            if (!isSilent) setIsLoading(true);
            setIsSyncing(true);
            try {
                const fetched = await db.fetchTables(uniqueTables, forceFull);
                const newlyLoadedMutable: CachedTableName[] = [];

                for (const [tbl, rows] of Object.entries(fetched)) {
                    applyTableSlice(tbl, rows);
                    loadedTablesRef.current.add(tbl);
                    if (
                        (MUTABLE_LARGE_TABLES as readonly string[]).includes(tbl) &&
                        !reconciledTablesRef.current.has(tbl) &&
                        !forceFull
                    ) {
                        reconciledTablesRef.current.add(tbl);
                        newlyLoadedMutable.push(tbl as CachedTableName);
                    }
                }
                setLoadedTableCount(loadedTablesRef.current.size);
                setDbError(null);

                if (newlyLoadedMutable.length > 0) {
                    setTimeout(() => {
                        const stillNeeded = newlyLoadedMutable.filter(t => requiredTablesRef.current.has(t));
                        if (stillNeeded.length === 0) return;
                        db.reconcileMutableTableIds(stillNeeded).then((diffs) => {
                            for (const [tableName, rows] of Object.entries(diffs)) {
                                if (Array.isArray(rows) && requiredTablesRef.current.has(tableName)) {
                                    applyTableSlice(tableName, rows);
                                }
                            }
                        }).catch(() => { });
                    }, 3500);
                }
            } catch (error: any) {
                console.error("Fetch Module Data Error:", error);
                setDbError(error.message);
            } finally {
                setIsSyncing(false);
                if (!isSilent) setIsLoading(false);
                inFlightFetchRef.current = null;
                const queued = queuedFetchRef.current;
                if (queued) {
                    queuedFetchRef.current = null;
                    void fetchTablesScoped(Array.from(queued.tables), queued.silent, queued.forceFull);
                }
            }
        })();

        inFlightFetchRef.current = promise;
        return promise;
    }, [applyTableSlice]);

    const refreshOpenModules = useCallback(async (
        isSilent: boolean = true,
        forceFull: boolean = false,
        specificTables?: string[],
        forceReconcile: boolean = false
    ): Promise<void> => {
        const targets = specificTables
            ? specificTables.filter(t => requiredTablesRef.current.has(t) || loadedTablesRef.current.has(t))
            : Array.from(requiredTablesRef.current);

        if (forceReconcile && !forceFull) {
            const mutableTargets = targets.filter((t): t is CachedTableName =>
                (MUTABLE_LARGE_TABLES as readonly string[]).includes(t)
            );
            if (mutableTargets.length > 0) {
                const diffs = await db.reconcileMutableTableIds(mutableTargets, { force: true });
                for (const [tbl, rows] of Object.entries(diffs)) {
                    if (Array.isArray(rows) && requiredTablesRef.current.has(tbl)) {
                        applyTableSlice(tbl, rows);
                    }
                }
            }
        }

        return fetchTablesScoped(targets, isSilent, forceFull);
    }, [fetchTablesScoped, applyTableSlice]);

    // Only load tables required by open windows/modals, and release heavy cached tables when all windows needing them are closed
    useEffect(() => {
        if (!isAuthenticated) return;

        const requiredSet = new Set(requiredTablesList);

        // Release heavy cached tables when no open module requires them to save browser RAM & avoid background sync
        let releasedAny = false;
        for (const cachedTbl of CACHED_LARGE_TABLES) {
            if (loadedTablesRef.current.has(cachedTbl) && !requiredSet.has(cachedTbl)) {
                loadedTablesRef.current.delete(cachedTbl);
                applyTableSlice(cachedTbl, []);
                releasedAny = true;
            }
        }
        if (releasedAny) {
            setLoadedTableCount(loadedTablesRef.current.size);
        }

        const missingTables = requiredTablesList.filter(tbl => !loadedTablesRef.current.has(tbl));
        if (missingTables.length > 0) {
            void fetchTablesScoped(missingTables, false, false);
        }
    }, [isAuthenticated, requiredTablesList, fetchTablesScoped, applyTableSlice]);

    useEffect(() => {
        if (!isAuthenticated) return;
        const checkSession = () => {
            const loginTs = localStorage.getItem('loginTimestamp');
            if (loginTs && (Date.now() - parseInt(loginTs, 10) > 8 * 60 * 60 * 1000)) {
                alert('Sesi Anda telah berakhir (8 jam). Silakan login kembali.');
                handleLogout();
            }
        };
        const interval = setInterval(checkSession, 60000);
        return () => clearInterval(interval);
    }, [isAuthenticated, currentUserName]);

    const getCurrentLocationRef = useRef(getCurrentLocation);

    useEffect(() => {
        getCurrentLocationRef.current = getCurrentLocation;
        if (isAuthenticated && currentUserName) {
            updateLiveStatus({
                onlineUsers: [{ user: currentUserName, location: getCurrentLocation() }],
            });
        }
    }, [getCurrentLocation, isAuthenticated, currentUserName, updateLiveStatus]);

    useEffect(() => {
        if (!isAuthenticated || !currentUserName) return;

        let cancelled = false;
        const pollHealth = async () => {
            const healthy = await checkBackendHealth();
            if (cancelled) return;
            updateLiveStatus({
                realtimeStatus: healthy ? 'connected' : 'error',
                onlineUsers: [{ user: currentUserName, location: getCurrentLocationRef.current() }],
            });
        };

        void pollHealth();
        const interval = setInterval(() => {
            void pollHealth();
        }, 30000);

        return () => {
            cancelled = true;
            clearInterval(interval);
            updateLiveStatus({ realtimeStatus: 'connecting', onlineUsers: [] });
        };
    }, [isAuthenticated, currentUserName, updateLiveStatus]);

    const handleLogin = async (u: string, p: string) => {
        setIsLoading(true);
        try {
            const userData = await db.verifyUser(u, p);
            if (userData) {
                setWindows([INITIAL_WINDOW]);
                setActiveWindowId(INITIAL_WINDOW.id);
                setLayoutMode('single');
                setIsAuthenticated(true);
                setCurrentUserName(userData.user || u);
                setUserRole(userData.role || 'admin');
                try {
                    localStorage.setItem('loginTimestamp', Date.now().toString());
                } catch { }
            } else {
                alert('Username atau password salah!');
            }
        } catch (e: any) { alert('Error Login: ' + e.message); } finally { setIsLoading(false); }
    };

    const handleLogout = useCallback(async () => {
        if (currentUserName && hasAuthToken()) {
            try { await db.addActivityLog(currentUserName, 'LOGOUT', 'users', currentUserName); } catch (e) { }
        }
        clearAuthToken();
        loadedTablesRef.current.clear();
        reconciledTablesRef.current.clear();
        rawDataRef.current = { ...EMPTY_RAW_DATA };
        setLoadedTableCount(0);
        setWindows([INITIAL_WINDOW]);
        setActiveWindowId(INITIAL_WINDOW.id);
        setLayoutMode('single');
        setIsAuthenticated(false); setCurrentUserName(''); setUserRole('admin');
        try { localStorage.removeItem('isLoggedIn'); localStorage.removeItem('username'); localStorage.removeItem('userRole'); localStorage.removeItem('loginTimestamp'); } catch (e) { }
    }, [currentUserName]);

    useEffect(() => {
        setOnUnauthorized(() => {
            void handleLogout();
        });
        return () => setOnUnauthorized(null);
    }, [handleLogout]);

    const handleApplyPending = async (record: any) => {
        try {
            const dateStr = new Date(record.date).toISOString().slice(0, 10);
            await db.applyProductionBatch(dateStr, record.truckNumber.toString(), currentUserName);
            await refreshOpenModules(true, false, ['production_logs', 'current_stock', 'stock_logs']);
            alert('Produksi berhasil di-apply ke stok.');
        } catch (e: any) { alert('Gagal: ' + e.message); }
    };

    const handleInvoiceSubmit = async (invoicesArray: Omit<Invoice, 'id' | 'date' | 'timestamp'>[], isEdit: boolean = false, useLiveDebt: boolean = false) => {
        setIsLoading(true);
        try {
            let refDateStr: string;
            let refDate: Date;
            if (!isEdit && orderToInvoice) {
                const y = orderToInvoice.date.getUTCFullYear();
                const m = String(orderToInvoice.date.getUTCMonth() + 1).padStart(2, '0');
                const d = String(orderToInvoice.date.getUTCDate()).padStart(2, '0');
                refDateStr = `${y}-${m}-${d}`;
                refDate = orderToInvoice.date;
            } else if (isEdit && invoiceToEdit) {
                const y = invoiceToEdit.date.getUTCFullYear();
                const m = String(invoiceToEdit.date.getUTCMonth() + 1).padStart(2, '0');
                const d = String(invoiceToEdit.date.getUTCDate()).padStart(2, '0');
                refDateStr = `${y}-${m}-${d}`;
                refDate = invoiceToEdit.date;
            } else {
                const now = new Date();
                const y = now.getFullYear();
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const d = String(now.getDate()).padStart(2, '0');
                refDateStr = `${y}-${m}-${d}`;
                refDate = new Date(`${refDateStr}T00:00:00Z`);
            }

            let invoiceId = isEdit ? invoicesArray[0].editInvoiceId! : '';

            if (!isEdit) {
                const [yearStr, monthStr, dayStr] = refDateStr.split('-');
                const datePart = `${dayStr}${monthStr}${yearStr.slice(-2)}`;

                const sameDayInvoices = invoices.filter((inv: Invoice) => {
                    const y = inv.date.getUTCFullYear();
                    const m = String(inv.date.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(inv.date.getUTCDate()).padStart(2, '0');
                    return `${y}-${m}-${d}` === refDateStr;
                });
                const lastInvSeqs = sameDayInvoices.map((inv: Invoice) => parseInt(inv.id.split('/').pop() || '0'));
                const nextInvSeq = (lastInvSeqs.length > 0 ? Math.max(...lastInvSeqs) : 0) + 1;
                invoiceId = `INV/${datePart}/${nextInvSeq.toString().padStart(3, '0')}`;
            }

            const dbEntries = invoicesArray.map(inv => ({
                tanggal: refDateStr,
                nomor_sj: inv.deliveryOrderId,
                nomor_invoice: invoiceId,
                customer: inv.customer,
                item_name: inv.itemName,
                harga: Number(inv.items[0]?.price) || 0,
                total: Number(inv.items[0]?.total) || 0,
                transfer: Number(inv.transfer) || 0,
                cash: Number(inv.cash) || 0,
                qty_diterima: Number(inv.qtyDiterima) || 0,
                keterangan: ((inv.keterangan || '').replace('[REKAMAN]', '').trim() + (!useLiveDebt ? ' [REKAMAN]' : '')).trim(),
                invoice_status: inv.status
            }));

            if (isEdit) {
                await db.updateInvoice(invoiceId, dbEntries, currentUserName);
            } else {
                await db.addInvoices(dbEntries, currentUserName);
            }

            const sjID = invoicesArray[0].deliveryOrderId;
            if (sjID && !sjID.startsWith('MANUAL-')) {
                const existingSJ = deliveryOrders.find((o: DeliveryOrder) => o.id === sjID);
                if (existingSJ) {
                    const updatedOrder = { ...existingSJ, items: [...existingSJ.items], receivedItems: [...(existingSJ.receivedItems || [])] };
                    let hasChanges = false;

                    invoicesArray.forEach((inv: Omit<Invoice, 'id' | 'date' | 'timestamp'>) => {
                        const invItemObj = inv.items[0];
                        if (invItemObj) {
                            const foundItem = updatedOrder.items.find((i: AllocationItem) => i.name === inv.itemName);
                            if (foundItem) {
                                if (foundItem.quantity !== inv.qtyDiterima) {
                                    hasChanges = true;
                                    foundItem.quantity = inv.qtyDiterima;
                                }
                            } else {
                                hasChanges = true;
                                updatedOrder.items.push({ name: inv.itemName, quantity: inv.qtyDiterima });
                            }

                            const foundReceived = updatedOrder.receivedItems?.find((ri: AllocationItem) => ri.name === inv.itemName);
                            if (foundReceived) {
                                if (foundReceived.quantity !== inv.qtyDiterima) {
                                    hasChanges = true;
                                    foundReceived.quantity = inv.qtyDiterima;
                                }
                            } else {
                                hasChanges = true;
                                if (!updatedOrder.receivedItems) updatedOrder.receivedItems = [];
                                updatedOrder.receivedItems.push({ name: inv.itemName, quantity: inv.qtyDiterima });
                            }
                        }
                    });

                    if (hasChanges) {
                        try {
                            await db.syncDeliveryOrderFromInvoice(sjID, updatedOrder, currentUserName);
                        } catch (err) {
                            console.error("Gagal update SJ dari Invoice", err);
                        }
                    }
                }
            }

            setOrderToInvoice(null);
            setInvoiceToEdit(null);
            setSelectedSJ(null);

            const savedInvoice: Invoice = {
                ...invoicesArray[0],
                keterangan: ((invoicesArray[0].keterangan || '').replace('[REKAMAN]', '').trim() + (!useLiveDebt ? ' [REKAMAN]' : '')).trim(),
                id: invoiceId,
                date: refDate,
                timestamp: new Date().toISOString(),
                items: invoicesArray.flatMap(inv => inv.items),
                subtotal: invoicesArray.reduce((sum, inv) => sum + inv.subtotal, 0),
                qtyDiterima: invoicesArray.reduce((sum, inv) => sum + inv.qtyDiterima, 0),
            };
            setSelectedInv(savedInvoice);

            await refreshOpenModules(true, false, ['invoices', 'delivery_orders', 'ledger_entries', 'current_stock', 'stock_logs']);
            alert('Invoice berhasil disimpan!');
        } catch (error: any) {
            alert('Gagal: ' + error.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleAllocationSubmit = async (allocs: { customer: string; items: AllocationItem[] }[], selectedDate: string) => {
        setIsLoading(true);
        try {
            const todayStr = selectedDate;
            const [year, month, day] = selectedDate.split('-').map(Number);
            const datePart = `${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}${year.toString().slice(-2)}`;

            const todaySJs = deliveryOrders.filter((o: DeliveryOrder) => new Date(o.date).toISOString().slice(0, 10) === todayStr);
            const lastSeqs = todaySJs.map((sj: DeliveryOrder) => parseInt(sj.id.split('/').pop() || '0'));
            let nextSeqNum = (lastSeqs.length > 0 ? Math.max(...lastSeqs) : 0) + 1;

            const adjustQty = (_name: string, q: number) => q;

            const deliveryOrderPromises = [];
            for (const al of allocs) {
                const chunks: AllocationItem[][] = []; for (let i = 0; i < al.items.length; i += 15) { chunks.push(al.items.slice(i, i + 15)); }
                for (const chunk of chunks) {
                    const sjNumber = `DO/${datePart}/${nextSeqNum.toString().padStart(3, '0')}`;
                    nextSeqNum++;
                    deliveryOrderPromises.push(
                        db.addDeliveryOrders(chunk.map(it => ({
                            tanggal: todayStr,
                            nomor_sj: sjNumber,
                            customer: al.customer,
                            nama_item: it.name,
                            qty_kirim: it.quantity,
                            qty_kirim2: adjustQty(it.name, it.quantity)
                        })), currentUserName)
                    );
                }
            }
            await Promise.all(deliveryOrderPromises);
            setIsAllocating(false);
            openOrFocusPreset('logistics', 'delivery_orders');
            await refreshOpenModules(true, false, ['delivery_orders', 'current_stock', 'stock_logs']);
            alert('Surat Jalan berhasil dibuat!');
        } catch (error: any) { alert('Gagal membuat SJ: ' + error.message); }
        finally { setIsLoading(false); }
    };

    useEffect(() => {
        if (pendingInvoiceOrder) {
            handleSelectInvoicing(pendingInvoiceOrder);
            setPendingInvoiceOrder(null);
        }
    }, [invoices, pendingInvoiceOrder]);

    const handleSelectInvoicing = (order: DeliveryOrder) => {
        if (order.invoiceId) {
            const existingInv = invoices.find((inv: Invoice) => inv.id === order.invoiceId);
            if (existingInv) {
                setInvoiceToEdit(existingInv);
                setOrderToInvoice(order);
                return;
            }
        }
        const dateStr = new Date(order.date).toISOString().slice(0, 10);
        const relatedSJs = deliveryOrders.filter((o: DeliveryOrder) => o.customer === order.customer && new Date(o.date).toISOString().slice(0, 10) === dateStr && o.status === 'received' && !o.invoiceId);
        if (relatedSJs.length > 1 && window.confirm(`Gabungkan ${relatedSJs.length} SJ untuk ${order.customer}?`)) {
            const combinedMap = new Map<string, number>(); const sjNumbers: string[] = [];
            relatedSJs.forEach((sj: DeliveryOrder) => { sjNumbers.push(sj.id); (sj.receivedItems?.length ? sj.receivedItems : sj.items).forEach((it: AllocationItem) => combinedMap.set(it.name, (combinedMap.get(it.name) || 0) + it.quantity)); });
            setOrderToInvoice({ ...order, id: sjNumbers.join(', '), items: Array.from(combinedMap.entries()).map(([name, quantity]) => ({ name, quantity })), receivedItems: Array.from(combinedMap.entries()).map(([name, quantity]) => ({ name, quantity })) });
        } else { setOrderToInvoice(order); }
    };

    const handleDeleteProduction = async (date: string, truckNumber: string) => {
        if (!window.confirm(`Hapus data produksi Mobil #${truckNumber} tanggal ${date}?`)) return;
        try {
            await db.deleteProductionBatch(date, truckNumber, currentUserName);
            await refreshOpenModules(true, false, ['production_logs', 'current_stock', 'stock_logs']);
            alert('Data produksi dihapus.');
        } catch (e: any) { alert('Gagal: ' + e.message); }
    };

    const handleDeleteSJ = async (sjNumber: string) => {
        if (!window.confirm(`Hapus Surat Jalan ${sjNumber}?`)) return;
        try {
            await db.deleteDeliveryOrder(sjNumber, currentUserName);
            await refreshOpenModules(true, false, ['delivery_orders', 'invoices', 'ledger_entries', 'current_stock', 'stock_logs']);
            alert('SJ Berhasil dihapus.');
        } catch (e: any) { alert('Gagal: ' + e.message); }
    };

    const renderWindowContent = (win: AppWindow) => {
        const logisticsTab = win.view === 'logistics' ? (win.subTab || 'stock') : 'stock';
        const financeTab = win.view === 'finance' ? (win.subTab || 'chicken_prices') : 'chicken_prices';
        const reportTab = win.view === 'reports' ? (win.subTab || 'dashboard') : 'dashboard';
        const stockSubView = win.stockSubView || 'main';

        return (
            <>
                {win.view === 'production' && (
                    <div className="space-y-6">
                        <ProductionForm
                            onSubmit={async (n: number, c: string, d: string, l: string, e: number, k: number, m: number, mk: number, it: Record<string, number>, pr: number, auto: boolean, date: string) => {
                                setIsLoading(true);
                                try {
                                    await db.addProductionLogs(Object.entries(it).filter(([_, q]) => Number(q) > 0).map(([i, q]) => ({ tanggal_produksi: date, item_name: i, qty: Number(q), ekor: e, kg: k, mobil: n.toString(), plat: l, harga_beli_kg: pr, kematian_ekor: m, kematian_kg: mk, nama_kandang: c, driver: d })), auto, currentUserName);
                                    await refreshOpenModules(true, false, ['production_logs', 'current_stock', 'stock_logs']);
                                } finally {
                                    setIsLoading(false);
                                }
                            }}
                            coops={coops}
                            licensePlates={licensePlates}
                            masterItems={masterItems}
                            existingLogs={productionLogs}
                        />
                        {pendingLogs.length > 0 && (
                            <div className="bg-slate-900/5 p-4 rounded-[2.5rem] border border-slate-200">
                                <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest mb-4 px-2">Antrian Produksi</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {pendingLogs.map((log: any, idx: number) => (
                                        <div key={idx} className="bg-white p-4 rounded-3xl border border-slate-100 shadow-sm">
                                            <div className="flex justify-between mb-3"><span className="text-[8px] font-black text-slate-400 uppercase bg-slate-50 px-2 py-1 rounded-full">Mobil #{log.truckNumber}</span><span className="text-[8px] font-black text-orange-600 bg-orange-50 px-2 py-1 rounded-full uppercase">Pending</span></div>
                                            <h4 className="font-black text-slate-800 text-base">{log.coopName}</h4>
                                            <p className="text-[9px] text-slate-400 font-bold mb-3 uppercase">{new Date(log.date).toLocaleDateString('id-ID')}</p>
                                            <div className="flex gap-2">
                                                <button onClick={() => handleApplyPending(log)} className="flex-1 py-3 bg-slate-900 text-white rounded-xl font-black text-[10px] uppercase">Apply</button>
                                                {userRole?.toLowerCase().trim() === 'superadmin' && <button onClick={() => handleDeleteProduction(new Date(log.date).toISOString().slice(0, 10), log.truckNumber.toString())} className="p-3 bg-rose-50 text-rose-600 rounded-xl"><TrashIcon /></button>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {win.view === 'logistics' && (
                    <div className="space-y-4">
                        <div className="flex justify-end">
                            <button onClick={() => setIsManualSJOpen(true)} className="px-5 py-2.5 bg-slate-900 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95">
                                + SJ MANUAL (Quick Print)
                            </button>
                        </div>
                        {logisticsTab === 'stock' ? (
                            stockSubView === 'history' ? (
                                <StockHistoryView logs={stockLogs} onBack={() => updateWindow(win.id, { stockSubView: 'main' })} />
                            ) : stockSubView === 'trading' ? (
                                <TradingHistoryView
                                    logs={tradingPurchases}
                                    onBack={() => updateWindow(win.id, { stockSubView: 'main' })}
                                    userRole={userRole}
                                    onEdit={(log: any) => { setTradingPurchaseToEdit(log); setIsTradingPurchaseOpen(true); }}
                                    onDelete={async (id: string, date: string) => {
                                        if (window.confirm(`Hapus pembelian trading tanggal ${new Date(date).toLocaleDateString('id-ID')}?`)) {
                                            try {
                                                await db.deleteTradingPurchase(id, currentUserName);
                                                await refreshOpenModules(true, false, ['trading_purchases', 'current_stock', 'stock_logs']);
                                                alert("Dihapus.");
                                            } catch (e: any) { alert(e.message); }
                                        }
                                    }}
                                />
                            ) : stockSubView === 'disposal' ? (
                                <DisposalHistoryView
                                    logs={stockDisposals}
                                    onBack={() => updateWindow(win.id, { stockSubView: 'main' })}
                                    userRole={userRole}
                                    onEdit={(log: any) => { setDisposalToEdit(log); setIsDisposalOpen(true); }}
                                    onDelete={async (id: string, date: string) => {
                                        if (window.confirm(`Hapus pemusnahan tanggal ${new Date(date).toLocaleDateString('id-ID')}?`)) {
                                            try {
                                                await db.deleteStockDisposal(id, currentUserName);
                                                await refreshOpenModules(true, false, ['stock_disposals', 'current_stock', 'stock_logs']);
                                                alert("Dihapus.");
                                            } catch (e: any) { alert(e.message); }
                                        }
                                    }}
                                />
                            ) : (
                                <StockView
                                    stock={stock}
                                    stockLogs={stockLogs}
                                    onStartAllocation={() => setIsAllocating(true)}
                                    onStartOpname={() => setIsOpnameOpen(true)}
                                    onViewHistory={() => updateWindow(win.id, { stockSubView: 'history' })}
                                    onViewTradingHistory={() => updateWindow(win.id, { stockSubView: 'trading' })}
                                    onViewDisposalHistory={() => updateWindow(win.id, { stockSubView: 'disposal' })}
                                    onStartTradingPurchase={() => setIsTradingPurchaseOpen(true)}
                                    onStartDisposal={() => setIsDisposalOpen(true)}
                                />
                            )
                        ) : logisticsTab === 'delivery_orders' ? (
                            <DeliveryOrderList deliveryOrders={deliveryOrders} onSelectOrder={(order: DeliveryOrder) => setSelectedSJ(order)} customers={customers} onDeleteSJ={handleDeleteSJ} userRole={userRole} />
                        ) : (
                            <div className="bg-white p-6 rounded-[2.5rem] border border-slate-200">
                                <DailyRecapReport productionHistory={productionLogs} deliveryOrders={deliveryOrders} tradingPurchases={tradingPurchases} stockDisposals={stockDisposals} masterItems={masterItems} stockLogs={stockLogs} />
                            </div>
                        )}
                    </div>
                )}

                {win.view === 'finance' && (
                    <div className="space-y-4">
                        <div className="flex flex-wrap justify-end gap-2">
                            <button onClick={() => setIsManualInvoiceOpen(true)} className="px-5 py-2.5 bg-purple-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-purple-700 transition-all shadow-lg active:scale-95">
                                + INV MANUAL (Quick Print)
                            </button>
                            <button onClick={() => setIsEndingInventoryOpen(true)} className="px-5 py-2.5 bg-rose-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all shadow-lg active:scale-95">
                                + INPUT MANUAL STOK
                            </button>
                        </div>
                        {financeTab === 'ledger' && <LedgerView
                            ledgerEntries={ledgerEntries}
                            invoices={invoices}
                            deliveryOrders={deliveryOrders}
                            customers={customers}
                            customerDebts={customerDebts}
                            userRole={userRole}
                            onRefresh={async () => {
                                const diffs = await db.reconcileMutableTableIds(['invoices', 'delivery_orders', 'ledger_entries'], { force: true });
                                for (const [tbl, rows] of Object.entries(diffs)) {
                                    if (Array.isArray(rows) && requiredTablesRef.current.has(tbl)) applyTableSlice(tbl, rows);
                                }
                                await refreshOpenModules(true, false, ['ledger_entries', 'invoices', 'delivery_orders', 'master_customers']);
                            }}
                            onAddPayment={async (d) => { await db.addLedgerEntry({ customer_id: d.customerId, tanggal: d.date.toISOString().slice(0, 10), keterangan: d.description, debit: 0, credit: d.credit, metode_bayar: d.paymentMethod, bukti_bayar: d.paymentProof }, currentUserName); await refreshOpenModules(true, false, ['ledger_entries']); }}
                            onAddManualPurchase={async (d) => { await db.addLedgerEntry({ customer_id: d.customerId, tanggal: d.date.toISOString().slice(0, 10), keterangan: d.description, debit: d.debit, credit: 0, bukti_bayar: d.paymentProof }, currentUserName); await refreshOpenModules(true, false, ['ledger_entries']); }}
                            onDeleteLedgerEntry={async (id) => { if (window.confirm('Hapus transaksi ini?')) { await db.deleteLedgerEntry(id, currentUserName); await refreshOpenModules(true, false, ['ledger_entries']); } }}
                            onEditLedgerEntry={async (id, d) => { if (window.confirm('Update transaksi ini?')) { await db.deleteLedgerEntry(id, currentUserName); await db.addLedgerEntry({ customer_id: d.customerId, tanggal: d.date.toISOString().slice(0, 10), keterangan: d.description, debit: d.debit, credit: d.credit, metode_bayar: d.paymentMethod, bukti_bayar: d.paymentProof }, currentUserName); await refreshOpenModules(true, false, ['ledger_entries']); } }}
                            onEditInvoice={(inv) => setInvoiceToEdit(inv)}
                            onDeleteInvoice={async (id) => { if (window.confirm('Hapus invoice ini?')) { await db.deleteInvoice(id, currentUserName); await refreshOpenModules(true, false, ['invoices', 'ledger_entries']); } }}
                            onSelectSJ={(sj) => setSelectedSJ(sj)}
                        />}
                        {financeTab === 'chicken_prices' && <CoopPriceForm productionHistory={[...productionLogs, ...pendingLogs]} onUpdatePrices={async (updates: any) => { try { await db.updateProductionPrices(updates, currentUserName); await refreshOpenModules(true, false, ['production_logs']); alert('Harga Beli Terupdate'); } catch (e: any) { alert(e.message); } }} onCancel={() => { }} />}
                        {financeTab === 'invoices_list' && <InvoiceList invoices={invoices} customerDebts={customerDebts} onSelectInvoice={(inv: Invoice) => setSelectedInv(inv)} />}
                        {financeTab === 'expenses' && <ExpenseView expenses={expenses} onAddExpense={() => setIsAddingExpense(true)} onDeleteExpense={async (id: string) => { if (window.confirm('Hapus record ini?')) { await db.deleteExpense(id, currentUserName); await refreshOpenModules(true, false, ['expenses']); } }} />}
                        {financeTab === 'salaries' && <SalaryView salaries={salaries} onAddSalary={() => setIsAddingSalary(true)} onDeleteSalary={async (id: string) => { if (window.confirm('Hapus data gaji ini?')) { await db.deleteSalary(id, currentUserName); await refreshOpenModules(true, false, ['salaries']); } }} onImportSalaries={(data: any) => { setSalaryImportData(data); setIsAddingSalary(true); }} />}
                        {financeTab === 'stock_value' && <div className="bg-white p-6 rounded-[2.5rem] border border-slate-200"><StockValueReport stockLogs={stockLogs} invoices={invoices} masterItems={masterItems} stock={stock} productionHistory={productionLogs} deliveryOrders={deliveryOrders} onInputEarlyStock={async (date: string, value: number) => { try { await db.upsertEarlyStock(date, value, currentUserName); await refreshOpenModules(true, false, ['early_stock']); alert('Saldo Awal berhasil disimpan.'); } catch (e: any) { alert(e.message); } }} /></div>}
                        {financeTab === 'profit_loss' && <div className="bg-white p-6 rounded-[2.5rem] border border-slate-200"><ProfitLossView invoices={invoices} productionHistory={[...productionLogs, ...pendingLogs]} expenses={expenses} salaries={salaries} stockLogs={stockLogs} tradingPurchases={tradingPurchases} stockDisposals={stockDisposals} stock={stock} ledgerEntries={ledgerEntries} earlyStock={earlyStock} masterItems={masterItems} /></div>}
                        {financeTab === 'belanja_lb' && <div className="bg-white p-6 rounded-[2.5rem] border border-slate-200"><BelanjaLBReport productionHistory={[...productionLogs, ...pendingLogs]} /></div>}
                        {financeTab === 'hpp' && <div className="bg-white p-6 rounded-[2.5rem] border border-slate-200"><HPPView productionHistory={productionLogs} expenses={expenses} invoices={invoices} masterItems={masterItems} /></div>}
                    </div>
                )}

                {win.view === 'reports' && (
                    <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border border-slate-200">
                        {reportTab === 'dashboard' && <DashboardReport productionHistory={[...productionLogs, ...pendingLogs]} deliveryOrders={deliveryOrders} invoices={invoices} expenses={expenses} salaries={salaries} stockLogs={stockLogs} stock={stock} ledgerEntries={ledgerEntries} tradingPurchases={tradingPurchases} stockDisposals={stockDisposals} earlyStock={earlyStock} onSelectPNL={() => openOrFocusPreset('finance', 'profit_loss')} />}
                        {reportTab === 'production' && <ProductionReport productionHistory={productionLogs} userRole={userRole} onDeleteRecord={handleDeleteProduction} onEditRecord={(rec: any) => setProductionToEdit(rec)} />}
                        {reportTab === 'sales_history' && <SalesReportHistory deliveryOrders={deliveryOrders} invoices={invoices} onSelectSJ={(order: DeliveryOrder) => setSelectedSJ(order)} onSelectInvoice={(inv: Invoice) => setSelectedInv(inv)} />}
                    </div>
                )}

                {win.view === 'database' && (
                    <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200">
                        <DatabaseManagement
                            coops={coops}
                            licensePlates={licensePlates}
                            customers={customers}
                            masterItems={masterItems}
                            customerDebts={customerDebts}
                            onSubTabChange={(sub: DatabaseSubTab) => updateWindow(win.id, { dbSubTab: sub })}
                            onAdd={async (type: string, data: any) => {
                                await db.addMasterData(type, data, currentUserName);
                                await refreshOpenModules(true, false, ['master_coops', 'master_plates', 'master_customers', 'master_items']);
                            }}
                            onDelete={async (type: string, identifier: string) => {
                                if (db.deleteMasterData) {
                                    await db.deleteMasterData(type, identifier, currentUserName);
                                } else {
                                    alert('Fungsi hapus sedang disiapkan.');
                                }
                                await refreshOpenModules(true, false, ['master_coops', 'master_plates', 'master_customers', 'master_items']);
                            }}
                            onUpdateCustomer={async (oldName: string, newName: string, newAddress: string) => {
                                await db.updateCustomerName(oldName, newName, newAddress, currentUserName);
                                await refreshOpenModules(true, false, ['master_customers', 'delivery_orders', 'invoices', 'ledger_entries']);
                                alert('Data customer dan transaksi terkait berhasil diperbarui.');
                            }}
                        />
                    </div>
                )}

                {win.view === 'dataLogger' && (
                    <ActivityHistoryView />
                )}
            </>
        );
    };

    if (!isAuthenticated) return <Login onLogin={handleLogin} />;

    const isSplitActive = layoutMode === 'split' && windows.length > 1;

    return (
        <div className="min-h-screen bg-slate-50 relative overflow-hidden">
            {isLoading && (
                <div className="fixed inset-0 bg-slate-900/10 backdrop-blur-md z-[9999] flex items-center justify-center">
                    <div className="w-12 h-12 border-[4px] border-indigo-600 border-t-transparent rounded-full animate-spin shadow-xl bg-white/20 p-2" />
                </div>
            )}
            <div className="print:hidden">
                <LiveStatusHeader
                    statusRef={liveStatusRef}
                    listenersRef={liveStatusListenersRef}
                    activeView={activeView}
                    openWindows={windows}
                    onOpenSubModule={handleOpenModuleWindow}
                    onLogout={handleLogout}
                    userRole={userRole}
                />
            </div>
            <main className="flex-1 mt-16 p-3 md:p-6 lg:p-8 max-w-[1600px] mx-auto w-full print:hidden">
                <WorkspaceBar
                    windows={windows}
                    activeWindowId={activeWindow.id}
                    layoutMode={layoutMode}
                    loadedTableCount={loadedTableCount}
                    isSyncing={isSyncing}
                    onFocusWindow={(id) => setActiveWindowId(id)}
                    onCloseWindow={handleCloseWindow}
                    onOpenModuleWindow={handleOpenModuleWindow}
                    onSetLayoutMode={setLayoutMode}
                    onRefreshOpenModules={() => void refreshOpenModules(false, false, undefined, true)}
                />

                {dbError ? (
                    <div className="bg-rose-50 border border-rose-100 p-8 rounded-3xl text-rose-700 font-bold text-center">
                        <p>Koneksi Error: {dbError}</p>
                        <button onClick={() => void refreshOpenModules(false, false)} className="mt-4 px-6 py-2 bg-rose-600 text-white rounded-xl">Coba Lagi</button>
                    </div>
                ) : isSplitActive ? (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                        {windows.map((win) => {
                            const isFocused = win.id === activeWindow.id;
                            return (
                                <section
                                    key={win.id}
                                    onMouseDown={() => {
                                        if (!isFocused) setActiveWindowId(win.id);
                                    }}
                                    className={`rounded-[2rem] border bg-slate-50/70 transition-all flex flex-col overflow-hidden ${
                                        isFocused
                                            ? 'border-indigo-400 ring-2 ring-indigo-500/15 shadow-lg'
                                            : 'border-slate-200/80 shadow-sm hover:border-slate-300'
                                    }`}
                                >
                                    <div className={`px-4 py-2.5 flex items-center justify-between border-b ${
                                        isFocused ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200/70'
                                    }`}>
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className={`w-2 h-2 rounded-full ${isFocused ? 'bg-emerald-400' : 'bg-slate-300'}`} />
                                            <span className="text-[10px] font-black uppercase tracking-widest truncate">
                                                {getWindowTitle(win)}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveWindowId(win.id);
                                                    setLayoutMode('single');
                                                }}
                                                className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-wider ${
                                                    isFocused ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                                }`}
                                            >
                                                Fokus
                                            </button>
                                            {windows.length > 1 && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleCloseWindow(win.id);
                                                    }}
                                                    className={`p-1 rounded-lg ${
                                                        isFocused ? 'text-slate-300 hover:text-white hover:bg-white/10' : 'text-slate-400 hover:text-rose-600 hover:bg-rose-50'
                                                    }`}
                                                    title="Tutup window"
                                                >
                                                    <XIcon className="h-3.5 w-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="p-3 md:p-4 max-h-[calc(100vh-11rem)] overflow-y-auto no-scrollbar">
                                        {renderWindowContent(win)}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                ) : (
                    <>
                        {windows.map((win) => (
                            <div key={win.id} className={win.id === activeWindow.id ? 'block' : 'hidden'}>
                                {renderWindowContent(win)}
                            </div>
                        ))}
                    </>
                )}
            </main>
            {isAllocating && <AllocationForm stock={stock} customers={customers} masterItems={masterItems} onSubmit={handleAllocationSubmit} onCancel={() => setIsAllocating(false)} />}
            {isTradingPurchaseOpen && <TradingPurchaseForm initialData={tradingPurchaseToEdit || undefined} stock={stock} masterItems={masterItems} onSubmit={async (d: any) => { try { setIsLoading(true); if (tradingPurchaseToEdit) { await db.editTradingPurchase(tradingPurchaseToEdit.id, { tanggal: d.date.toISOString().slice(0, 10), item_name: d.itemName, kg: d.quantity, harga_per_kg: d.pricePerKg }, currentUserName); setTradingPurchaseToEdit(null); } else { await db.addTradingPurchase({ tanggal: d.date.toISOString().slice(0, 10), item_name: d.itemName, kg: d.quantity, harga_per_kg: d.pricePerKg }, currentUserName); } setIsTradingPurchaseOpen(false); await refreshOpenModules(true, false, ['trading_purchases', 'current_stock', 'stock_logs']); } catch (e: any) { alert(e.message); } finally { setIsLoading(false); } }} onCancel={() => { setIsTradingPurchaseOpen(false); setTradingPurchaseToEdit(null); }} />}
            {isDisposalOpen && <StockDisposalForm initialData={disposalToEdit || undefined} stock={stock} masterItems={masterItems} onSubmit={async (d: any) => { try { setIsLoading(true); if (disposalToEdit) { await db.editStockDisposal(disposalToEdit.id, { tanggal: d.date.toISOString().slice(0, 10), item_name: d.itemName, kg: d.quantity, harga_valuasi_kg: d.pricePerKg, keterangan: d.notes }, currentUserName); setDisposalToEdit(null); } else { await db.addStockDisposal({ tanggal: d.date.toISOString().slice(0, 10), item_name: d.itemName, kg: d.quantity, harga_valuasi_kg: d.pricePerKg, keterangan: d.notes }, currentUserName); } setIsDisposalOpen(false); await refreshOpenModules(true, false, ['stock_disposals', 'current_stock', 'stock_logs']); } catch (e: any) { alert(e.message); } finally { setIsLoading(false); } }} onCancel={() => { setIsDisposalOpen(false); setDisposalToEdit(null); }} />}
            {isOpnameOpen && <StockOpnameForm
                stockLogs={stockLogs}
                currentStock={stock}
                masterItems={masterItems}
                onSubmit={async (data: Record<string, number>, date: string) => {
                    setIsLoading(true);
                    try {
                        const todayStr = new Date().toLocaleDateString('en-CA');
                        const isToday = date === todayStr;

                        console.log(`[Opname] Memulai opname batch untuk tanggal: ${date} (Hari ini: ${isToday})`);
                        const items = Object.entries(data).map(([itemName, realQtyVal]) => ({
                            itemName,
                            targetQty: parseFloat(String(realQtyVal)),
                        }));

                        const { updatedCount, skipCount, errorCount, errors } = await db.syncStockOpnameBatch(
                            items,
                            date,
                            isToday,
                            currentUserName
                        );

                        console.log(`[Opname] Selesai. Sukses: ${updatedCount}, Lewat: ${skipCount}, Gagal: ${errorCount}`);

                        await refreshOpenModules(true, false, ['current_stock', 'stock_logs']);
                        setIsOpnameOpen(false);

                        let message = `Proses Selesai.\n- Berhasil disesuaikan: ${updatedCount} item`;
                        if (skipCount > 0) message += `\n- Dilewati (stok sudah sesuai): ${skipCount} item`;
                        if (errorCount > 0) message += `\n- GAGAL: ${errorCount} item.`;

                        if (errors.length > 0) {
                            console.table(errors);
                            alert(message + '\n\nDetail error tersimpan di log konsol.');
                        } else {
                            alert(message);
                        }
                    } catch (e: any) {
                        console.error('[Opname] Fatal Error:', e);
                        alert('Gagal total menjalankan opname: ' + e.message);
                    } finally {
                        setIsLoading(false);
                    }
                }}
                onCancel={() => setIsOpnameOpen(false)}
            />}
            {isAddingExpense && <ExpenseForm onSubmit={async (d: any) => {
                if (Array.isArray(d)) {
                    await db.addExpenses(d, currentUserName);
                } else {
                    await db.addExpense(d, currentUserName);
                }
                setIsAddingExpense(false);
                await refreshOpenModules(true, false, ['expenses']);
            }} onCancel={() => setIsAddingExpense(false)} />}
            {isAddingSalary && <SalaryForm initialData={salaryImportData || undefined} onSubmit={async (d: any) => { await db.addSalaries(d, currentUserName); setIsAddingSalary(false); setSalaryImportData(null); await refreshOpenModules(true, false, ['salaries']); }} onCancel={() => { setIsAddingSalary(false); setSalaryImportData(null); }} />}
            {isManualSJOpen && <ManualSJForm customers={customers} masterItems={masterItems} onCancel={() => setIsManualSJOpen(false)} />}
            {isManualInvoiceOpen && <ManualInvoiceForm customers={customers} masterItems={masterItems} onCancel={() => setIsManualInvoiceOpen(false)} />}
            {isEndingInventoryOpen && <EndingInventoryForm
                earlyStock={earlyStock}
                currentUserName={currentUserName}
                onSubmit={async (date: string, amount: number) => {
                    await db.upsertEarlyStock(date, amount, currentUserName);
                    await refreshOpenModules(true, false, ['early_stock']);
                    alert('Data Ending Inventory berhasil diperbarui.');
                }}
                onDelete={async (date: string) => {
                    await db.deleteEarlyStock(date, currentUserName);
                    await refreshOpenModules(true, false, ['early_stock']);
                }}
                onCancel={() => setIsEndingInventoryOpen(false)}
            />}

            {selectedSJ && <DeliveryOrderDetail order={selectedSJ} masterItems={masterItems} onClose={() => setSelectedSJ(null)} onUpdateOrder={async (o: DeliveryOrder) => {
                try {
                    await db.updateDeliveryOrderWithStock(o, currentUserName);
                    await refreshOpenModules(true, false, ['delivery_orders', 'current_stock', 'stock_logs']);
                    setSelectedSJ(null);
                    setPendingInvoiceOrder(o);
                } catch (e: any) {
                    alert('Gagal: ' + e.message);
                }
            }} onStartInvoicing={handleSelectInvoicing} />}
            {(orderToInvoice && !invoiceToEdit) && <InvoiceForm order={orderToInvoice} previousDebt={customerDebts[orderToInvoice.customer] || 0} liveDebt={customerDebts[orderToInvoice.customer] || 0} onSubmit={handleInvoiceSubmit} onCancel={() => setOrderToInvoice(null)} />}
            {selectedInv && <InvoiceDetail invoice={selectedInv} liveDebt={customerDebts[selectedInv.customer] || 0} onClose={() => setSelectedInv(null)} onEdit={(inv: Invoice) => { setInvoiceToEdit(inv); setSelectedInv(null); }} />}
            {invoiceToEdit && <InvoiceForm initialData={invoiceToEdit} order={orderToInvoice || undefined} previousDebt={invoiceToEdit.previousDebt} liveDebt={Math.max(0, (customerDebts[invoiceToEdit.customer] || 0) - (invoiceToEdit.subtotal - invoiceToEdit.amountPaid))} onSubmit={handleInvoiceSubmit} onCancel={() => { setInvoiceToEdit(null); setOrderToInvoice(null); }} />}
            {productionToEdit && <ProductionEditModal record={productionToEdit} coops={coops} licensePlates={licensePlates} masterItems={masterItems} onSubmit={async (updates: any, isApplied: boolean) => { try { const dateStr = new Date(productionToEdit.date).toISOString().slice(0, 10); await db.deleteProductionBatch(dateStr, productionToEdit.truckNumber.toString(), currentUserName); await db.addProductionLogs(updates, isApplied, currentUserName); setProductionToEdit(null); await refreshOpenModules(true, false, ['production_logs', 'current_stock', 'stock_logs']); alert('Data produksi terupdate.'); } catch (e: any) { alert('Gagal: ' + e.message); } }} onCancel={() => setProductionToEdit(null)} />}
        </div>
    );
};

export default App;
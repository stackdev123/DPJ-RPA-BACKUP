import React, { useState, useMemo, useRef, useEffect } from 'react';
import download from 'downloadjs';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import type { LedgerEntry, Customer, Invoice, DeliveryOrder } from '../types';
import DebtPaymentForm from './DebtPaymentForm';
import ManualPurchaseForm from './ManualPurchaseForm';
import { DownloadIcon, XIcon, ChevronDownIcon, InfoIcon, EditIcon, TrashIcon, FileTextIcon, TruckIcon } from './icons';
import { db } from '../apiClient';
import { compressImageToBase64 } from '../imageUtils';

interface LedgerViewProps {
    ledgerEntries: LedgerEntry[];
    invoices: Invoice[];
    deliveryOrders: DeliveryOrder[];
    customers: Customer[];
    customerDebts: { [key: string]: number };
    userRole?: string;
    onRefresh?: () => Promise<void>;
    onAddPayment: (paymentData: Omit<LedgerEntry, 'id' | 'balance' | 'debit' | 'timestamp'>) => void;
    onAddManualPurchase: (purchaseData: Omit<LedgerEntry, 'id' | 'balance' | 'credit' | 'timestamp'>) => void;
    onDeleteLedgerEntry?: (id: string) => Promise<void>;
    onEditLedgerEntry?: (id: string, data: any) => Promise<void>;
    onEditInvoice?: (inv: Invoice) => void;
    onDeleteInvoice?: (id: string) => Promise<void>;
    onSelectSJ?: (sj: DeliveryOrder) => void;
}

const formatCurrency = (value: number) => {
    if (value === 0) return '-';
    const formatted = new Intl.NumberFormat('id-ID', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(value);
    return `Rp ${formatted}`;
};

type FilterType = 'month' | 'range' | 'all';
type ViewMode = 'detail' | 'summary';

const SearchableCustomerSelect = ({ options, value, onChange, placeholder }: { options: string[], value: string, onChange: (val: string) => void, placeholder: string }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const filteredOptions = useMemo(() => {
        return options.filter(opt => opt.toLowerCase().includes(search.toLowerCase()));
    }, [options, search]);

    return (
        <div className="relative inline-block min-w-[220px]" ref={containerRef}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-black text-indigo-700 outline-none uppercase hover:border-indigo-200 transition-all text-left"
            >
                <span className="truncate">{value || placeholder}</span>
                <ChevronDownIcon className={`h-4 w-4 text-indigo-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-100 shadow-2xl rounded-2xl z-[150] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    <div className="p-2 border-b border-slate-50">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Cari pelanggan..."
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/10"
                            autoFocus
                        />
                    </div>
                    <div className="max-h-60 overflow-y-auto no-scrollbar py-1">
                        <button
                            onClick={() => { onChange(''); setIsOpen(false); setSearch(''); }}
                            className={`w-full text-left px-4 py-2 text-xs font-black uppercase transition-colors hover:bg-slate-50 ${value === '' ? 'text-indigo-600 bg-indigo-50/50' : 'text-slate-600'}`}
                        >
                            {placeholder}
                        </button>
                        {filteredOptions.map((opt) => (
                            <button
                                key={opt}
                                onClick={() => { onChange(opt); setIsOpen(false); setSearch(''); }}
                                className={`w-full text-left px-4 py-2 text-xs font-black uppercase transition-colors hover:bg-slate-50 ${value === opt ? 'text-indigo-600 bg-indigo-50/50' : 'text-slate-600'}`}
                            >
                                {opt}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const LedgerView: React.FC<LedgerViewProps> = ({
    ledgerEntries, invoices, deliveryOrders, customers, customerDebts, userRole, onRefresh, onAddPayment, onAddManualPurchase, onDeleteLedgerEntry, onEditLedgerEntry, onEditInvoice, onDeleteInvoice, onSelectSJ
}) => {
    const [viewMode, setViewMode] = useState<ViewMode>('detail');
    const [selectedCustomer, setSelectedCustomer] = useState<string>('');
    const [isPayingDebt, setIsPayingDebt] = useState(false);
    const [isAddingPurchase, setIsAddingPurchase] = useState(false);
    const [editingEntry, setEditingEntry] = useState<any>(null);
    const [selectedTransaction, setSelectedTransaction] = useState<any>(null);
    const [fetchedPaymentProof, setFetchedPaymentProof] = useState<string | null>(null);
    const [isLoadingProof, setIsLoadingProof] = useState(false);

    useEffect(() => {
        if (selectedTransaction && selectedTransaction.type === 'ledger') {
            setFetchedPaymentProof(null);
            setIsLoadingProof(true);
            db.getLedgerPaymentProof(selectedTransaction.id)
                .then(proof => {
                    setFetchedPaymentProof(proof);
                })
                .catch(err => {
                    console.error("Gagal mengambil bukti bayar:", err);
                })
                .finally(() => {
                    setIsLoadingProof(false);
                });
        } else {
            setFetchedPaymentProof(null);
        }
    }, [selectedTransaction]);

    const [filterType, setFilterType] = useState<FilterType>('month');
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
    const [dateRange, setDateRange] = useState({ start: '', end: '' });
    const [isProcessing, setIsProcessing] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const reportRef = useRef<HTMLDivElement>(null);
    const downloadHiddenRef = useRef<HTMLDivElement>(null);

    const groupedByCustomer = useMemo(() => {
        const invMap = new Map<string, Invoice[]>();
        for (const inv of invoices) {
            const list = invMap.get(inv.customer);
            if (list) list.push(inv);
            else invMap.set(inv.customer, [inv]);
        }

        const ledMap = new Map<string, LedgerEntry[]>();
        for (const e of ledgerEntries) {
            const list = ledMap.get(e.customerId);
            if (list) list.push(e);
            else ledMap.set(e.customerId, [e]);
        }

        return { invMap, ledMap };
    }, [invoices, ledgerEntries]);

    const boundaries = useMemo(() => {
        let start: Date | null = null;
        let end: Date | null = null;

        if (filterType === 'month') {
            const [year, month] = selectedMonth.split('-').map(Number);
            start = new Date(year, month - 1, 1);
            end = new Date(year, month, 0, 23, 59, 59, 999);
        } else if (filterType === 'range' && dateRange.start && dateRange.end) {
            start = new Date(dateRange.start);
            start.setHours(0, 0, 0, 0);
            end = new Date(dateRange.end);
            end.setHours(23, 59, 59, 999);
        }
        return {
            start,
            end,
            startMs: start ? start.getTime() : null,
            endMs: end ? end.getTime() : null,
        };
    }, [filterType, selectedMonth, dateRange]);

    const summaryData = useMemo(() => {
        const { startMs, endMs } = boundaries;
        const useFilter = filterType !== 'all' && startMs !== null && endMs !== null;

        return customers.map(cust => {
            let totalPembelian = 0;
            let totalTransfer = 0;
            let totalCash = 0;

            const custInvoices = groupedByCustomer.invMap.get(cust.name);
            if (custInvoices) {
                for (const inv of custInvoices) {
                    if (useFilter) {
                        const dMs = inv.dateMs ?? new Date(inv.date).getTime();
                        if (dMs < startMs! || dMs > endMs!) continue;
                    }
                    totalPembelian += Number(inv.subtotal) || 0;
                    totalTransfer += Number(inv.transfer) || 0;
                    totalCash += Number(inv.cash) || 0;
                }
            }

            const custLedger = groupedByCustomer.ledMap.get(cust.name);
            if (custLedger) {
                for (const e of custLedger) {
                    if (useFilter) {
                        const dMs = e.dateMs ?? new Date(e.date).getTime();
                        if (dMs < startMs! || dMs > endMs!) continue;
                    }
                    totalPembelian += Number(e.debit) || 0;
                    if (e.paymentMethod === 'Transfer') totalTransfer += Number(e.credit) || 0;
                    if (e.paymentMethod === 'Cash') totalCash += Number(e.credit) || 0;
                }
            }

            const sisaPiutang = totalPembelian - (totalTransfer + totalCash);

            return {
                name: cust.name,
                totalPembelian,
                totalTransfer,
                totalCash,
                sisaPiutang
            };
        }).sort((a, b) => b.sisaPiutang - a.sisaPiutang);
    }, [customers, groupedByCustomer, filterType, boundaries]);

    const processedData = useMemo(() => {
        if (!selectedCustomer) return { initialBalance: 0, rows: [] };
        const allTransactions: any[] = [];

        const custLedger = groupedByCustomer.ledMap.get(selectedCustomer) || [];
        for (const e of custLedger) {
            const dMs = e.dateMs ?? new Date(e.date).getTime();
            allTransactions.push({
                id: e.id,
                type: 'ledger',
                customerId: e.customerId,
                description: e.description || 'Manual Entry',
                date: e.date,
                dateMs: dMs,
                ts: e.timestamp || '',
                pembelian: Math.abs(Number(e.debit || 0)),
                transfer: e.paymentMethod === 'Transfer' ? Math.abs(Number(e.credit || 0)) : 0,
                cash: e.paymentMethod === 'Cash' ? Math.abs(Number(e.credit || 0)) : 0,
                paymentProof: e.paymentProof
            });
        }

        const custInvoices = groupedByCustomer.invMap.get(selectedCustomer) || [];
        for (const inv of custInvoices) {
            const dMs = inv.dateMs ?? new Date(inv.date).getTime();
            allTransactions.push({
                id: inv.id,
                type: 'invoice',
                customerId: inv.customer,
                description: `Invoice ${inv.id}`,
                date: inv.date,
                dateMs: dMs,
                ts: inv.timestamp || '',
                pembelian: Math.abs(Number(inv.subtotal || 0)),
                transfer: Math.abs(Number(inv.transfer || 0)),
                cash: Math.abs(Number(inv.cash || 0)),
            });
        }

        allTransactions.sort((a, b) => a.dateMs - b.dateMs || a.ts.localeCompare(b.ts));

        let currentPiutang = 0;
        let initialPiutang = 0;
        const rows: any[] = [];
        const { startMs, endMs } = boundaries;

        for (const t of allTransactions) {
            currentPiutang = currentPiutang + t.pembelian - (t.transfer + t.cash);

            if (startMs !== null && t.dateMs < startMs) {
                initialPiutang = currentPiutang;
            } else if (endMs === null || t.dateMs <= endMs) {
                rows.push({
                    ...t,
                    balance: currentPiutang
                });
            }
        }

        return { initialBalance: initialPiutang, rows };
    }, [groupedByCustomer, selectedCustomer, boundaries]);

    const totals = useMemo(() => {
        return processedData.rows.reduce((acc, entry) => {
            acc.pembelian += entry.pembelian;
            acc.transfer += entry.transfer;
            acc.cash += entry.cash;
            return acc;
        }, { pembelian: 0, transfer: 0, cash: 0 });
    }, [processedData.rows]);

    const chunkData = (data: any[], size: number) => {
        const chunks = [];
        for (let i = 0; i < data.length; i += size) {
            chunks.push(data.slice(i, i + size));
        }
        return chunks;
    };

    const DETAIL_ROWS_PER_PAGE = 22;
    const SUMMARY_ROWS_PER_PAGE = 26;

    const handleDownload = async (format: 'pdf' | 'jpg') => {
        setIsProcessing(true);
        try {
            await document.fonts.ready;
            const fileName = `Ledger-${viewMode === 'detail' ? selectedCustomer : 'Rekap'}-${new Date().getTime()}`;

            if (format === 'jpg') {
                const element = reportRef.current;
                if (!element) throw new Error("Element not found");

                // Ensure elements are visible for capture
                const header = element.querySelector('#jpg-report-header') as HTMLElement;
                const scrollableDivs = element.querySelectorAll('.overflow-x-auto');
                const hiddenWrappers = element.querySelectorAll('.overflow-hidden');

                const originalStyles: { el: HTMLElement, overflow: string, width: string, minWidth: string }[] = [];
                const originalHiddenStyles: { el: HTMLElement, overflow: string, width: string, minWidth: string }[] = [];

                scrollableDivs.forEach((div) => {
                    const el = div as HTMLElement;
                    originalStyles.push({ el, overflow: el.style.overflow, width: el.style.width, minWidth: el.style.minWidth });
                    el.style.overflow = 'visible';
                    el.style.width = '1200px';
                    el.style.minWidth = '1200px';
                });

                hiddenWrappers.forEach((div) => {
                    const el = div as HTMLElement;
                    originalHiddenStyles.push({ el, overflow: el.style.overflow, width: el.style.width, minWidth: el.style.minWidth });
                    el.style.overflow = 'visible';
                    el.style.width = '1200px';
                    el.style.minWidth = '1200px';
                });

                const originalHeaderDisplay = header ? header.style.display : '';
                const originalElementWidth = element.style.width;
                const originalElementMinWidth = element.style.minWidth;

                element.style.width = '1200px';
                element.style.minWidth = '1200px';

                if (header) {
                    header.style.display = 'flex';
                }

                const canvas = await html2canvas(element, {
                    scale: 4,
                    backgroundColor: "#ffffff",
                    useCORS: true,
                    width: 1200,
                    height: element.scrollHeight,
                    windowWidth: 1200,
                    windowHeight: element.scrollHeight,
                    scrollX: 0,
                    scrollY: 0,
                    onclone: (clonedDoc) => {
                        const images = clonedDoc.getElementsByTagName('img');
                        for (let i = 0; i < images.length; i++) {
                            images[i].style.display = 'inline-block';
                        }
                    }
                });

                // Restore original styles
                element.style.width = originalElementWidth;
                element.style.minWidth = originalElementMinWidth;
                scrollableDivs.forEach((div, index) => {
                    const el = div as HTMLElement;
                    el.style.overflow = originalStyles[index].overflow;
                    el.style.width = originalStyles[index].width;
                    el.style.minWidth = originalStyles[index].minWidth;
                });
                hiddenWrappers.forEach((div, index) => {
                    const el = div as HTMLElement;
                    el.style.overflow = originalHiddenStyles[index].overflow;
                    el.style.width = originalHiddenStyles[index].width;
                    el.style.minWidth = originalHiddenStyles[index].minWidth;
                });

                if (header) {
                    header.style.display = originalHeaderDisplay;
                }

                const imgData = canvas.toDataURL('image/jpeg', 0.98);
                download(imgData, `${fileName}.jpg`, "image/jpeg");
            } else {
                const element = downloadHiddenRef.current;
                if (!element) throw new Error("Element not found");

                const pages = element.querySelectorAll('.pdf-page');
                const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

                for (let i = 0; i < pages.length; i++) {
                    const page = pages[i] as HTMLElement;
                    const canvas = await html2canvas(page, {
                        scale: 4,
                        backgroundColor: "#ffffff",
                        useCORS: true,
                        width: page.offsetWidth,
                        height: page.offsetHeight,
                        windowWidth: page.offsetWidth,
                        windowHeight: page.offsetHeight,
                        scrollX: 0,
                        scrollY: 0,
                        onclone: (clonedDoc) => {
                            const images = clonedDoc.getElementsByTagName('img');
                            for (let i = 0; i < images.length; i++) {
                                images[i].style.display = 'inline-block';
                            }
                        }
                    });

                    if (canvas.width === 0 || canvas.height === 0) continue;

                    const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    const pdfWidth = pdf.internal.pageSize.getWidth();
                    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

                    if (i > 0) pdf.addPage();
                    pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
                }
                const pdfBlob = pdf.output('blob');
                download(pdfBlob, `${fileName}.pdf`, "application/pdf");
            }
        } catch (e) {
            console.error(e);
            alert("Gagal mengunduh laporan");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDownloadXLSX = () => {
        const fileName = `Ledger-${viewMode === 'detail' ? selectedCustomer : 'Rekap'}-${new Date().getTime()}.xlsx`;

        if (viewMode === 'summary') {
            const wsData = summaryData.map(row => ({
                'Nama Pelanggan': row.name,
                'Total Pembelian': row.totalPembelian,
                'Total Transfer': row.totalTransfer,
                'Total Cash': row.totalCash,
                'Sisa Piutang': row.sisaPiutang
            }));

            wsData.push({
                'Nama Pelanggan': 'GRAND TOTAL',
                'Total Pembelian': summaryData.reduce((a, b) => a + b.totalPembelian, 0),
                'Total Transfer': summaryData.reduce((a, b) => a + b.totalTransfer, 0),
                'Total Cash': summaryData.reduce((a, b) => a + b.totalCash, 0),
                'Sisa Piutang': summaryData.reduce((a, b) => a + b.sisaPiutang, 0)
            });

            const ws = XLSX.utils.json_to_sheet(wsData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Rekap Piutang");
            XLSX.writeFile(wb, fileName);
        } else {
            if (!selectedCustomer) return;

            const wsData: any[] = [];
            if (processedData.initialBalance !== 0) {
                wsData.push({
                    'Tanggal': 'Awal',
                    'Debit (Beli)': 0,
                    'Kredit (Trf)': 0,
                    'Kredit (Cash)': 0,
                    'Saldo Akhir': processedData.initialBalance
                });
            }

            processedData.rows.forEach(row => {
                wsData.push({
                    'Tanggal': new Date(row.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
                    'Debit (Beli)': row.pembelian,
                    'Kredit (Trf)': row.transfer,
                    'Kredit (Cash)': row.cash,
                    'Saldo Akhir': row.balance
                });
            });

            wsData.push({
                'Tanggal': 'REKAPITULASI',
                'Debit (Beli)': totals.pembelian,
                'Kredit (Trf)': totals.transfer,
                'Kredit (Cash)': totals.cash,
                'Saldo Akhir': processedData.rows.length > 0 ? processedData.rows[processedData.rows.length - 1].balance : processedData.initialBalance
            });

            const ws = XLSX.utils.json_to_sheet(wsData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Detail Ledger");
            XLSX.writeFile(wb, fileName);
        }
    };

    const transactionData = useMemo(() => {
        if (!selectedTransaction) return null;
        if (selectedTransaction.type === 'invoice') {
            return invoices.find(inv => inv.id === selectedTransaction.id);
        }
        if (selectedTransaction.type === 'ledger') {
            return ledgerEntries.find(e => e.id === selectedTransaction.id);
        }
        return null;
    }, [selectedTransaction, invoices, ledgerEntries]);

    const relatedSJs = useMemo(() => {
        if (!selectedTransaction || selectedTransaction.type !== 'invoice') return [];
        return deliveryOrders.filter(sj => sj.invoiceId === selectedTransaction.id);
    }, [selectedTransaction, deliveryOrders]);

    return (
        <div className="relative bg-white p-4 md:p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-6 min-h-[500px]">
            {/* Transaction Detail Modal */}
            {selectedTransaction && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 no-print">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200 animate-in fade-in zoom-in duration-200">
                        <div className="bg-slate-900 px-6 py-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-indigo-500/20 rounded-lg">
                                    <InfoIcon className="w-5 h-5 text-indigo-400" />
                                </div>
                                <h3 className="text-white font-black uppercase tracking-widest text-sm">Detail Transaksi</h3>
                            </div>
                            <button
                                onClick={() => setSelectedTransaction(null)}
                                className="p-2 hover:bg-white/10 rounded-full transition-colors text-white/60 hover:text-white"
                            >
                                <XIcon className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-8 space-y-6">
                            <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Tanggal</p>
                                    <p className="text-sm font-bold text-slate-900">
                                        {new Date(selectedTransaction.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })}
                                    </p>
                                </div>
                                <div className="space-y-1 text-right">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Tipe</p>
                                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase ${selectedTransaction.type === 'invoice' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'
                                        }`}>
                                        {selectedTransaction.type === 'invoice' ? 'Invoice' : 'Manual Entry'}
                                    </span>
                                </div>
                            </div>

                            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                                <div className="flex justify-between items-center">
                                    <p className="text-[10px] font-black text-slate-500 uppercase">Keterangan</p>
                                    <p className="text-xs font-bold text-slate-900">{selectedTransaction.description}</p>
                                </div>
                                <div className="h-px bg-slate-200" />
                                <div className="grid grid-cols-3 gap-4">
                                    <div className="text-center">
                                        <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Debit</p>
                                        <p className="text-xs font-bold text-indigo-600">{formatCurrency(selectedTransaction.pembelian)}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Trf</p>
                                        <p className="text-xs font-bold text-emerald-600">{formatCurrency(selectedTransaction.transfer)}</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Cash</p>
                                        <p className="text-xs font-bold text-amber-600">{formatCurrency(selectedTransaction.cash)}</p>
                                    </div>
                                </div>
                            </div>

                            {selectedTransaction.type === 'invoice' && relatedSJs.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Surat Jalan Terkait</p>
                                    <div className="space-y-1">
                                        {relatedSJs.map(sj => (
                                            <button
                                                key={sj.id}
                                                onClick={() => {
                                                    onSelectSJ?.(sj);
                                                    setSelectedTransaction(null);
                                                }}
                                                className="w-full flex items-center justify-between p-2 bg-white border border-slate-200 rounded-lg hover:border-indigo-500 hover:bg-indigo-50 transition-all group"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <TruckIcon className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" />
                                                    <span className="text-xs font-bold text-slate-700">SJ {sj.id}</span>
                                                </div>
                                                <ChevronDownIcon className="w-4 h-4 text-slate-300 -rotate-90" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {selectedTransaction.type === 'ledger' && (
                                <div className="space-y-2">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Bukti Bayar</p>
                                    <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50 flex justify-center items-center p-2 min-h-12">
                                        {isLoadingProof ? (
                                            <p className="text-xs text-slate-400 animate-pulse font-bold">Mengambil bukti bayar...</p>
                                        ) : fetchedPaymentProof ? (
                                            <img src={fetchedPaymentProof} alt="Bukti Bayar" className="max-h-48 object-contain rounded-lg" />
                                        ) : (
                                            <p className="text-xs text-slate-400 italic">Tidak ada bukti bayar</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {userRole?.toLowerCase().trim() === 'superadmin' && (
                                <div className="flex gap-3 pt-4 border-t border-slate-100">
                                    <button
                                        onClick={() => {
                                            if (selectedTransaction.type === 'invoice' && transactionData) {
                                                onEditInvoice?.(transactionData as Invoice);
                                            } else if (selectedTransaction.type === 'ledger') {
                                                setEditingEntry({
                                                    ...selectedTransaction,
                                                    paymentProof: fetchedPaymentProof || undefined
                                                });
                                            }
                                            setSelectedTransaction(null);
                                        }}
                                        className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 text-white py-3 rounded-xl font-black uppercase text-xs hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                                    >
                                        <EditIcon className="w-4 h-4" />
                                        Edit Transaksi
                                    </button>
                                    <button
                                        onClick={async () => {
                                            if (confirm('Apakah Anda yakin ingin menghapus transaksi ini?')) {
                                                if (selectedTransaction.type === 'invoice') {
                                                    await onDeleteInvoice?.(selectedTransaction.id);
                                                } else if (selectedTransaction.type === 'ledger') {
                                                    await onDeleteLedgerEntry?.(selectedTransaction.id);
                                                }
                                                setSelectedTransaction(null);
                                            }
                                        }}
                                        className="px-4 flex items-center justify-center bg-red-50 text-red-600 py-3 rounded-xl font-black uppercase text-xs hover:bg-red-100 transition-all border border-red-100"
                                    >
                                        <TrashIcon className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {/* UI SCREEN - NO PRINT */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-100 pb-6 no-print">
                <div className="space-y-1">
                    <div className="flex items-center gap-4">
                        <h2 className="text-xl md:text-2xl font-black text-slate-900 tracking-tighter uppercase">LEDGER</h2>
                        <div className="flex bg-slate-100 p-1 rounded-xl">
                            <button
                                onClick={() => setViewMode('detail')}
                                className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${viewMode === 'detail' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}
                            >DETAIL</button>
                            <button
                                onClick={() => setViewMode('summary')}
                                className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${viewMode === 'summary' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}
                            >REKAP</button>
                        </div>
                    </div>

                    {viewMode === 'detail' && (
                        <div className="flex items-center gap-3 mt-2">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pilih Pelanggan:</span>
                            <SearchableCustomerSelect
                                options={customers.map(c => c.name)}
                                value={selectedCustomer}
                                onChange={setSelectedCustomer}
                                placeholder="-- Pilih Pelanggan --"
                            />
                        </div>
                    )}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <div className="flex items-center gap-2 bg-slate-100/50 p-1.5 rounded-2xl border border-slate-200/60">
                        <select
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value as FilterType)}
                            className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-[9px] font-black uppercase outline-none"
                        >
                            <option value="all">Semua</option>
                            <option value="month">Bulan</option>
                            <option value="range">Range</option>
                        </select>
                        {filterType === 'month' && (
                            <input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none shadow-sm" />
                        )}
                        {filterType === 'range' && (
                            <div className="flex items-center gap-1">
                                <input type="date" value={dateRange.start} onChange={(e) => setDateRange(p => ({ ...p, start: e.target.value }))} className="bg-white border border-slate-200 rounded-xl px-2 py-1 text-[9px] font-bold outline-none w-24 shadow-sm" />
                                <input type="date" value={dateRange.end} onChange={(e) => setDateRange(p => ({ ...p, end: e.target.value }))} className="bg-white border border-slate-200 rounded-xl px-2 py-1 text-[9px] font-bold outline-none w-24 shadow-sm" />
                            </div>
                        )}
                    </div>

                    <div className="flex gap-1.5">
                        <div className="flex bg-slate-900 rounded-xl p-1 shadow-lg shadow-slate-100">
                            <button onClick={() => handleDownload('pdf')} disabled={(viewMode === 'detail' && !selectedCustomer) || isProcessing} className="px-3 py-2 text-white text-[9px] font-black uppercase tracking-widest border-r border-white/10 active:scale-95 disabled:opacity-30">PDF</button>
                            <button onClick={() => handleDownload('jpg')} disabled={(viewMode === 'detail' && !selectedCustomer) || isProcessing} className="px-3 py-2 text-white text-[9px] font-black uppercase tracking-widest border-r border-white/10 active:scale-95 disabled:opacity-30">JPG</button>
                            <button onClick={handleDownloadXLSX} disabled={(viewMode === 'detail' && !selectedCustomer) || isProcessing} className="px-3 py-2 text-white text-[9px] font-black uppercase tracking-widest active:scale-95 disabled:opacity-30">XLSX</button>
                        </div>
                        {onRefresh && (
                            <button
                                onClick={async () => {
                                    setIsRefreshing(true);
                                    try { await onRefresh(); } finally { setIsRefreshing(false); }
                                }}
                                disabled={isRefreshing}
                                title="Refresh data ledger"
                                className="px-3 py-2.5 bg-sky-500 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-sky-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                {isRefreshing ? '...' : 'Refresh'}
                            </button>
                        )}
                        {userRole?.toLowerCase().trim() === 'superadmin' && (
                            <>
                                <button onClick={() => setIsAddingPurchase(true)} className="px-4 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all active:scale-95">Manual</button>
                                <button onClick={() => setIsPayingDebt(true)} className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest shadow-lg shadow-emerald-50 active:scale-95 transition-all">Bayar</button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Application Screen UI (Scrollable Single View) */}
            <div ref={reportRef} id="ledger-main-report" className="bg-white p-2">
                {/* JPG ONLY HEADER - Visible during capture via onclone */}
                <div id="jpg-report-header" className="mb-8 border-b-4 border-double border-black pb-6 flex justify-between items-end" style={{ display: 'none' }}>
                    <div className="flex items-center gap-5">
                        <img src="/logo.png" alt="Logo" className="h-20 w-auto grayscale" />
                        <div style={{ lineHeight: '1.2' }}>
                            <h2 className="text-3xl font-black uppercase">CV DPJ Berkah Unggas</h2>
                            <p className="text-[12px] font-bold uppercase tracking-widest mt-1">Rumah Potong Ayam & Supplier</p>
                            <p className="text-[10px] font-medium uppercase mt-1 opacity-50">LAPORAN PIUTANG PELANGGAN</p>
                        </div>
                    </div>
                    <div className="text-right" style={{ lineHeight: '1.2' }}>
                        <h1 className="text-4xl font-black uppercase mb-2">LEDGER</h1>
                        <div className="inline-block border-y-2 border-black py-1 px-4">
                            <p className="text-sm font-black uppercase">{viewMode === 'detail' ? selectedCustomer : 'REKAPITULASI GLOBAL'}</p>
                        </div>
                        <p className="text-[10px] font-bold mt-2 uppercase tracking-tight">PERIODE: {filterType === 'all' ? 'SEMUA WAKTU' : filterType === 'month' ? new Date(selectedMonth).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }) : `${dateRange.start} s/d ${dateRange.end}`}</p>
                    </div>
                </div>

                {viewMode === 'summary' ? (
                    <div className="bg-white border-2 border-black rounded-xl overflow-hidden shadow-sm">
                        <div className="overflow-x-auto no-scrollbar" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
                            <table className="min-w-full border-collapse">
                                <thead>
                                    <tr className="bg-slate-50 border-b-2 border-black text-[10px] font-black uppercase">
                                        <th className="px-4 py-3 text-left border-r border-black whitespace-nowrap">Nama Pelanggan</th>
                                        <th className="px-4 py-3 text-right border-r border-black whitespace-nowrap">Total Pembelian</th>
                                        <th className="px-4 py-3 text-right border-r border-black whitespace-nowrap">Total Transfer</th>
                                        <th className="px-4 py-3 text-right border-r border-black whitespace-nowrap">Total Cash</th>
                                        <th className="px-4 py-3 text-right bg-indigo-50 whitespace-nowrap">Sisa Piutang</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-black/10">
                                    {summaryData.map((row, idx) => (
                                        <tr key={idx} className="hover:bg-slate-50 transition-all font-bold text-[11px]">
                                            <td className="px-4 py-3 border-r border-black/10 uppercase font-black text-slate-800 whitespace-nowrap">{row.name}</td>
                                            <td className="px-4 py-3 border-r border-black/10 text-right font-mono whitespace-nowrap">{formatCurrency(row.totalPembelian)}</td>
                                            <td className="px-4 py-3 border-r border-black/10 text-right font-mono text-blue-600 whitespace-nowrap">{formatCurrency(row.totalTransfer)}</td>
                                            <td className="px-4 py-3 border-r border-black/10 text-right font-mono text-emerald-600 whitespace-nowrap">{formatCurrency(row.totalCash)}</td>
                                            <td className={`px-4 py-3 text-right font-black font-mono bg-indigo-50/30 whitespace-nowrap ${row.sisaPiutang < 0 ? 'text-emerald-600' : 'text-indigo-700'}`}>
                                                {formatCurrency(row.sisaPiutang)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot className="bg-black text-white font-black text-[10px] uppercase">
                                    <tr>
                                        <td className="px-4 py-4 whitespace-nowrap">GRAND TOTAL</td>
                                        <td className="px-4 py-4 text-right font-mono text-xs whitespace-nowrap">{formatCurrency(summaryData.reduce((a, b) => a + b.totalPembelian, 0))}</td>
                                        <td className="px-4 py-4 text-right font-mono text-xs whitespace-nowrap">{formatCurrency(summaryData.reduce((a, b) => a + b.totalTransfer, 0))}</td>
                                        <td className="px-4 py-4 text-right font-mono text-xs whitespace-nowrap">{formatCurrency(summaryData.reduce((a, b) => a + b.totalCash, 0))}</td>
                                        <td className="px-4 py-4 text-right font-mono text-sm text-yellow-400 whitespace-nowrap">{formatCurrency(summaryData.reduce((a, b) => a + b.sisaPiutang, 0))}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                ) : (
                    selectedCustomer ? (
                        <div className="bg-white border-2 border-black rounded-lg overflow-hidden shadow-sm">
                            <div className="overflow-x-auto no-scrollbar" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
                                <table className="min-w-full border-collapse">
                                    <thead>
                                        <tr className="border-b-2 border-black bg-slate-50 text-[10px] font-black uppercase">
                                            <th className="px-4 py-3 text-center border-r border-black w-24">Tanggal</th>
                                            <th className="px-4 py-3 text-center border-r border-black">Debit (Beli)</th>
                                            <th className="px-4 py-3 text-center border-r border-black">Kredit (Trf)</th>
                                            <th className="px-4 py-3 text-center border-r border-black">Kredit (Cash)</th>
                                            <th className="px-4 py-3 text-center bg-slate-100 border-r border-black">Saldo Akhir</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-[14px] text-black font-bold">
                                        {processedData.initialBalance !== 0 && (
                                            <tr className="border-b border-black/20 italic bg-slate-50">
                                                <td className="px-4 py-3 text-center border-r border-black/20 text-xs">Awal</td>
                                                <td colSpan={3} className="border-r border-black/20 text-center text-black/40 text-xs">-</td>
                                                <td className="px-4 py-3 text-center border-r border-black/20 font-mono font-black">{formatCurrency(processedData.initialBalance)}</td>
                                            </tr>
                                        )}
                                        {processedData.rows.length === 0 ? (
                                            <tr><td colSpan={5} className="py-24 text-center text-black uppercase tracking-widest font-black italic opacity-20 text-[10px]">Data transaksi tidak ditemukan</td></tr>
                                        ) : (
                                            processedData.rows.map((row, idx) => (
                                                <tr key={idx} className="border-b border-black/20 hover:bg-slate-50 transition-all">
                                                    <td
                                                        className="px-4 py-3 text-center border-r border-black/20 text-indigo-600 font-black uppercase whitespace-nowrap text-xs cursor-pointer hover:bg-indigo-50"
                                                        onClick={() => setSelectedTransaction(row)}
                                                    >
                                                        {new Date(row.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
                                                    </td>
                                                    <td className="px-4 py-3 text-center border-r border-black/20 font-mono font-black text-[15px] whitespace-nowrap">
                                                        {formatCurrency(row.pembelian)}
                                                    </td>
                                                    <td className="px-4 py-3 text-center border-r border-black/20 font-mono font-black text-[15px] whitespace-nowrap">
                                                        {formatCurrency(row.transfer)}
                                                    </td>
                                                    <td className="px-4 py-3 text-center border-r border-black/20 font-mono font-black text-[15px] whitespace-nowrap">
                                                        {formatCurrency(row.cash)}
                                                    </td>
                                                    <td className={`px-4 py-3 text-center border-r border-black/20 font-black font-mono text-[15px] bg-slate-50/50 whitespace-nowrap ${row.balance < 0 ? 'text-emerald-600' : ''}`}>
                                                        {formatCurrency(row.balance)}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                    <tfoot className="border-t-2 border-black bg-slate-50 font-black text-[10px] text-black uppercase tracking-widest">
                                        <tr>
                                            <td className="px-4 py-6 text-center border-r border-black whitespace-nowrap">Rekapitulasi</td>
                                            <td className="px-4 py-6 text-center border-r border-black font-mono text-sm whitespace-nowrap">{formatCurrency(totals.pembelian)}</td>
                                            <td className="px-4 py-6 text-center border-r border-black font-mono text-sm whitespace-nowrap">{formatCurrency(totals.transfer)}</td>
                                            <td className="px-4 py-6 text-center border-r border-black font-mono text-sm whitespace-nowrap">{formatCurrency(totals.cash)}</td>
                                            <td className={`px-4 py-6 text-center border-r border-black bg-black text-white font-mono text-base ring-1 ring-black whitespace-nowrap`}>
                                                {formatCurrency(processedData.rows.length > 0 ? processedData.rows[processedData.rows.length - 1].balance : processedData.initialBalance)}
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    ) : (
                        <div className="py-32 text-center bg-slate-50/50 rounded-[3rem] border-2 border-dashed border-slate-200">
                            <p className="text-slate-400 font-black uppercase tracking-widest text-xs">Pilih pelanggan untuk memuat rekap piutang</p>
                        </div>
                    )
                )}
            </div>

            {/* HIDDEN PAGES FOR MULTI-PAGE PDF DOWNLOAD ONLY */}
            <div style={{ position: 'absolute', left: '-9999px', top: '0', width: '210mm' }}>
                <div ref={downloadHiddenRef} style={{ background: '#fff' }}>
                    {viewMode === 'detail' && selectedCustomer && chunkData(processedData.rows, DETAIL_ROWS_PER_PAGE).map((chunk, pIdx, allChunks) => (
                        <div key={pIdx} className="pdf-page bg-white p-[12mm] w-[210mm] min-h-[297mm] flex flex-col font-sans text-black" style={{ boxSizing: 'border-box' }}>
                            {/* Kop Surat - Halaman Pertama */}
                            {pIdx === 0 ? (
                                <div className="border-b-4 border-double border-black pb-6 flex justify-between items-end mb-6">
                                    <div className="flex items-center gap-5">
                                        <img src="/logo.png" alt="Logo" className="h-16 w-auto grayscale" />
                                        <div style={{ lineHeight: '1.2' }}>
                                            <h2 className="text-2xl font-black uppercase">CV DPJ Berkah Unggas</h2>
                                            <p className="text-[10px] font-bold uppercase tracking-widest mt-1">Rumah Potong Ayam & Supplier</p>
                                        </div>
                                    </div>
                                    <div className="text-right" style={{ lineHeight: '1.2' }}>
                                        <h1 className="text-3xl font-black uppercase mb-1">LEDGER</h1>
                                        <div className="inline-block border-y border-black py-0.5 px-3">
                                            <p className="text-xs font-black uppercase">{selectedCustomer}</p>
                                        </div>
                                        <p className="text-[9px] font-bold mt-1 uppercase tracking-tighter">PERIODE: {new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="mb-4 flex justify-between items-center border-b-2 border-black pb-2" style={{ lineHeight: '1.2' }}>
                                    <div className="flex items-center gap-3">
                                        <p className="text-[10px] font-black uppercase tracking-widest">LEDGER: {selectedCustomer}</p>
                                    </div>
                                    <p className="text-[10px] font-bold uppercase">HALAMAN {pIdx + 1} / {allChunks.length}</p>
                                </div>
                            )}

                            <div className="flex-grow">
                                <table className="w-full border-collapse border-2 border-black">
                                    <thead>
                                        <tr className="bg-slate-50 border-b-2 border-black text-[10px] font-black uppercase">
                                            <th className="px-3 py-3 text-center border-r border-black w-24">Tanggal</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Debit (Beli)</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Kredit (Trf)</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Kredit (Cash)</th>
                                            <th className="px-3 py-3 text-center bg-slate-100">Saldo</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-[12px] font-bold">
                                        {pIdx === 0 && processedData.initialBalance !== 0 && (
                                            <tr className="bg-slate-50 border-b border-black/20 italic">
                                                <td className="px-3 py-2 text-center border-r border-black/20 text-[9px]">Awal</td>
                                                <td colSpan={3} className="text-center border-r border-black/20">-</td>
                                                <td className="px-3 py-2 text-center font-black">{formatCurrency(processedData.initialBalance)}</td>
                                            </tr>
                                        )}
                                        {chunk.map((row, idx) => (
                                            <tr key={idx} className="border-b border-black/20" style={{ lineHeight: '1.2' }}>
                                                <td className="px-3 py-3 text-center border-r border-black/20 uppercase font-black text-[9px]">
                                                    {new Date(row.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
                                                </td>
                                                <td className="px-3 py-3 border-r border-black/20 text-center font-mono">{formatCurrency(row.pembelian)}</td>
                                                <td className="px-3 py-3 border-r border-black/20 text-center font-mono">{formatCurrency(row.transfer)}</td>
                                                <td className="px-3 py-3 border-r border-black/20 text-center font-mono">{formatCurrency(row.cash)}</td>
                                                <td className={`px-3 py-3 text-center font-black font-mono ${row.balance < 0 ? 'text-emerald-600' : ''}`}>
                                                    {formatCurrency(row.balance)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    {pIdx === allChunks.length - 1 && (
                                        <tfoot className="border-t-2 border-black bg-slate-50 font-black text-[10px] uppercase">
                                            <tr>
                                                <td className="px-3 py-4 text-center border-r border-black">TOTAL</td>
                                                <td className="px-3 py-4 text-center border-r border-black font-mono">{formatCurrency(totals.pembelian)}</td>
                                                <td className="px-3 py-4 text-center border-r border-black font-mono">{formatCurrency(totals.transfer)}</td>
                                                <td className="px-3 py-4 text-center border-r border-black font-mono">{formatCurrency(totals.cash)}</td>
                                                <td className="px-3 py-4 text-center bg-black text-white font-mono">
                                                    {formatCurrency(processedData.rows[processedData.rows.length - 1]?.balance || 0)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    )}
                                </table>
                            </div>

                            {pIdx === allChunks.length - 1 && (
                                <div className="mt-8 pt-6 border-t border-black/10 grid grid-cols-2 gap-12" style={{ lineHeight: '1.2' }}>
                                    <div>
                                        <h4 className="text-[10px] font-black uppercase tracking-widest border-b-2 border-black inline-block pb-1 mb-4">Informasi Bayar</h4>
                                        <div className="space-y-3">
                                            <p className="text-[11px] font-black leading-none">BCA: 7410 8888 79 (Panji Pranantias)</p>
                                            <p className="text-[11px] font-black leading-none">BRI: 0075 0100 1986 565 (Panji Pranantias)</p>
                                            <p className="text-[11px] font-black leading-none">Mandiri: 1730 0811 8888 1 (Panji Pranantias)</p>
                                        </div>
                                    </div>
                                    <div className="text-center flex flex-col items-center justify-end">
                                        <p className="text-[9px] font-black uppercase tracking-widest opacity-30 mb-16">PENCATATAN SISTEM DPJ</p>
                                        <div className="w-48 border-t-2 border-black pt-2">
                                            <p className="text-[10px] font-black uppercase">Admin Keuangan</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}

                    {viewMode === 'summary' && chunkData(summaryData, SUMMARY_ROWS_PER_PAGE).map((chunk, pIdx, allChunks) => (
                        <div key={pIdx} className="pdf-page bg-white p-[12mm] w-[210mm] min-h-[297mm] flex flex-col font-sans text-black" style={{ boxSizing: 'border-box' }}>
                            <div className="border-b-4 border-double border-black pb-6 flex justify-between items-end mb-6">
                                <div className="flex items-center gap-5">
                                    <img src="/logo.png" alt="Logo" className="h-14 w-auto grayscale" />
                                    <div style={{ lineHeight: '1.2' }}>
                                        <h2 className="text-xl font-black uppercase">REKAP PIUTANG GLOBAL</h2>
                                        <p className="text-[10px] font-bold uppercase tracking-widest mt-1">CV DPJ Berkah Unggas</p>
                                    </div>
                                </div>
                                <div className="text-right" style={{ lineHeight: '1.2' }}>
                                    <p className="text-[10px] font-black uppercase">Halaman {pIdx + 1} / {allChunks.length}</p>
                                    <p className="text-[9px] font-bold uppercase tracking-tight">PERIODE: {filterType === 'all' ? 'SEMUA WAKTU' : new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}</p>
                                </div>
                            </div>

                            <div className="flex-grow">
                                <table className="w-full border-collapse border-2 border-black">
                                    <thead>
                                        <tr className="bg-slate-50 border-b-2 border-black text-[10px] font-black uppercase">
                                            <th className="px-3 py-3 text-left border-r border-black">Nama Pelanggan</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Pembelian</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Trf</th>
                                            <th className="px-3 py-3 text-center border-r border-black">Cash</th>
                                            <th className="px-3 py-3 text-center bg-indigo-50">Piutang</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-black/10">
                                        {chunk.map((row, idx) => (
                                            <tr key={idx} className="font-bold text-[11px]" style={{ lineHeight: '1.2' }}>
                                                <td className="px-3 py-2.5 border-r border-black/10 uppercase font-black">{row.name}</td>
                                                <td className="px-3 py-2.5 border-r border-black/10 text-center font-mono">{formatCurrency(row.totalPembelian)}</td>
                                                <td className="px-3 py-2.5 border-r border-black/10 text-center font-mono text-blue-600">{formatCurrency(row.totalTransfer)}</td>
                                                <td className="px-3 py-2.5 border-r border-black/10 text-center font-mono text-emerald-600">{formatCurrency(row.totalCash)}</td>
                                                <td className={`px-3 py-2.5 text-center font-black font-mono bg-indigo-50/30 ${row.sisaPiutang < 0 ? 'text-emerald-600' : 'text-indigo-700'}`}>
                                                    {formatCurrency(row.sisaPiutang)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    {pIdx === allChunks.length - 1 && (
                                        <tfoot className="bg-black text-white font-black text-[11px] uppercase shadow-inner">
                                            <tr>
                                                <td className="px-3 py-5">GRAND TOTAL</td>
                                                <td className="px-3 py-5 text-center font-mono">{formatCurrency(summaryData.reduce((a, b) => a + b.totalPembelian, 0))}</td>
                                                <td className="px-3 py-5 text-center font-mono">{formatCurrency(summaryData.reduce((a, b) => a + b.totalTransfer, 0))}</td>
                                                <td className="px-3 py-5 text-center font-mono">{formatCurrency(summaryData.reduce((a, b) => a + b.totalCash, 0))}</td>
                                                <td className="px-3 py-5 text-center font-mono text-yellow-400">{formatCurrency(summaryData.reduce((a, b) => a + b.sisaPiutang, 0))}</td>
                                            </tr>
                                        </tfoot>
                                    )}
                                </table>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {isPayingDebt && selectedCustomer && (
                <DebtPaymentForm
                    customerName={selectedCustomer}
                    currentDebt={customerDebts[selectedCustomer] || 0}
                    onSubmit={(d) => { onAddPayment(d); setIsPayingDebt(false); }}
                    onCancel={() => setIsPayingDebt(false)}
                />
            )}

            {isAddingPurchase && (
                <ManualPurchaseForm
                    customers={customers}
                    onSubmit={(d) => { onAddManualPurchase(d); setIsAddingPurchase(false); }}
                    onCancel={() => setIsAddingPurchase(false)}
                />
            )}

            {editingEntry && onEditLedgerEntry && (
                <EditLedgerEntryModal
                    entry={editingEntry}
                    onSave={onEditLedgerEntry}
                    onCancel={() => setEditingEntry(null)}
                />
            )}
        </div>
    );
};

const EditLedgerEntryModal: React.FC<{ entry: any; onSave: (id: string, data: any) => Promise<void>; onCancel: () => void }> = ({ entry, onSave, onCancel }) => {
    const [date, setDate] = useState(new Date(entry.date).toISOString().slice(0, 10));
    const [description, setDescription] = useState(entry.description || '');
    const [debit, setDebit] = useState(entry.pembelian || 0);
    const [credit, setCredit] = useState(entry.transfer > 0 ? entry.transfer : entry.cash);
    const [paymentMethod, setPaymentMethod] = useState<'Transfer' | 'Cash' | undefined>(entry.transfer > 0 ? 'Transfer' : (entry.cash > 0 ? 'Cash' : 'Transfer'));
    const [paymentProof, setPaymentProof] = useState<string | undefined>(entry.paymentProof);
    const [fileName, setFileName] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (file.size > 10 * 1024 * 1024) {
                alert("Ukuran file terlalu besar. Maksimal 10MB.");
                return;
            }
            try {
                const base64 = await compressImageToBase64(file, 1024, 0.7);
                setPaymentProof(base64);
                setFileName(file.name);
            } catch (error) {
                console.error("Error compressing image", error);
                alert("Gagal memproses file.");
            }
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            await onSave(entry.id, {
                date: new Date(date),
                description,
                debit: Number(debit),
                credit: Number(credit),
                paymentMethod: Number(credit) > 0 ? paymentMethod : undefined,
                paymentProof: Number(credit) > 0 ? paymentProof : undefined,
                customerId: entry.customerId
            });
            onCancel();
        } catch (err: any) {
            alert(err.message);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-[2rem] p-6 md:p-8 w-full max-w-md shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-xl font-black text-slate-900 uppercase">Edit Transaksi</h3>
                    <button onClick={onCancel} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><XIcon /></button>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tanggal</label>
                        <input type="date" required value={date} onChange={e => setDate(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" />
                    </div>
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Keterangan</label>
                        <input type="text" required value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" />
                    </div>
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Debit (Pembelian)</label>
                        <input type="number" min="0" value={debit} onChange={e => { setDebit(Number(e.target.value)); if (Number(e.target.value) > 0) setCredit(0); }} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" />
                    </div>
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Kredit (Pembayaran)</label>
                        <input type="number" min="0" value={credit} onChange={e => { setCredit(Number(e.target.value)); if (Number(e.target.value) > 0) setDebit(0); }} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all" />
                    </div>
                    {credit > 0 && (
                        <>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Metode Pembayaran</label>
                                <select required value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as any)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all">
                                    <option value="Transfer">Transfer</option>
                                    <option value="Cash">Cash</option>
                                </select>
                            </div>
                            {paymentMethod === 'Transfer' && (
                                <div>
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Bukti Transfer</label>
                                    <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-slate-300 border-dashed rounded-xl bg-slate-50">
                                        <div className="space-y-1 text-center">
                                            <div className="flex text-sm text-slate-600 justify-center">
                                                <label htmlFor="edit-file-upload" className="relative cursor-pointer bg-white rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500 px-2 py-1">
                                                    <span>Pilih file</span>
                                                    <input id="edit-file-upload" name="file-upload" type="file" className="sr-only" accept="image/png, image/jpeg, image/gif" onChange={handleFileChange} />
                                                </label>
                                            </div>
                                            <p className="text-xs text-slate-500">PNG, JPG, GIF hingga 2MB</p>
                                            {fileName && <p className="text-xs text-emerald-600 mt-2 font-semibold">{fileName}</p>}
                                            {!fileName && paymentProof && <p className="text-xs text-indigo-600 mt-2 font-semibold">Bukti sudah ada (pilih file baru untuk mengganti)</p>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                    <div className="flex gap-3 pt-4">
                        <button type="button" onClick={onCancel} className="flex-1 px-4 py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95">Batal</button>
                        <button type="submit" disabled={isSaving} className="flex-1 px-4 py-3 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50">Simpan</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default LedgerView;
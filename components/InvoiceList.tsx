import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { Invoice } from '../types';
import { ChevronDownIcon } from './icons';
import * as XLSX from 'xlsx';

interface InvoiceListProps {
    invoices: Invoice[];
    onSelectInvoice: (invoice: Invoice) => void;
    customerDebts?: { [key: string]: number };
}

const SearchableCustomerFilter = ({ options, value, onChange }: { options: string[], value: string, onChange: (val: string) => void }) => {
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
        <div className="relative w-full" ref={containerRef}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold text-slate-700 outline-none hover:border-indigo-200 transition-all text-left h-[38px]"
            >
                <span className="truncate">{value === 'all' ? 'Semua Pelanggan' : value}</span>
                <ChevronDownIcon className={`h-3 w-3 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-100 shadow-xl rounded-xl z-[150] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    <div className="p-2 border-b border-slate-50">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Cari..."
                            className="w-full px-2 py-1.5 bg-slate-50 border border-slate-100 rounded-lg text-[10px] font-bold outline-none"
                            autoFocus
                        />
                    </div>
                    <div className="max-h-48 overflow-y-auto no-scrollbar py-1">
                        <button
                            onClick={() => { onChange('all'); setIsOpen(false); setSearch(''); }}
                            className={`w-full text-left px-3 py-1.5 text-[10px] font-bold uppercase transition-colors hover:bg-slate-50 ${value === 'all' ? 'text-indigo-600 bg-indigo-50/50' : 'text-slate-600'}`}
                        >
                            Semua Pelanggan
                        </button>
                        {filteredOptions.map((opt) => (
                            <button
                                key={opt}
                                onClick={() => { onChange(opt); setIsOpen(false); setSearch(''); }}
                                className={`w-full text-left px-3 py-1.5 text-[10px] font-bold uppercase transition-colors hover:bg-slate-50 ${value === opt ? 'text-indigo-600 bg-indigo-50/50' : 'text-slate-600'}`}
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

const InvoiceList: React.FC<InvoiceListProps> = ({ invoices, onSelectInvoice, customerDebts }) => {
    const [search, setSearch] = useState('');
    const [filterCustomer, setFilterCustomer] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterDate, setFilterDate] = useState('');

    // Pagination state
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 20;

    // Reset pagination on filter change
    useEffect(() => {
        setCurrentPage(1);
    }, [search, filterCustomer, filterStatus, filterDate]);

    // Extract unique customers for filter
    const uniqueCustomers = useMemo(() => {
        return Array.from(new Set(invoices.map(inv => inv.customer))).sort();
    }, [invoices]);

    const getInvoiceStatusType = (invoice: Invoice) => {
        if (invoice.newDebt <= 0) return 'Lunas';
        if (invoice.amountPaid > 0) return 'Sebagian';
        return 'Belum';
    };

    const handleReset = () => {
        setSearch('');
        setFilterCustomer('all');
        setFilterStatus('all');
        setFilterDate('');
        setCurrentPage(1);
    };

    const filteredInvoices = useMemo(() => {
        return invoices.filter(inv => {
            const matchSearch = search === '' || inv.id.toLowerCase().includes(search.toLowerCase());
            const matchCust = filterCustomer === 'all' || inv.customer === filterCustomer;
            const matchStatus = filterStatus === 'all' || getInvoiceStatusType(inv) === filterStatus;
            
            let matchDate = true;
            if (filterDate) {
                const invDateStr = new Date(inv.date).toISOString().split('T')[0];
                matchDate = invDateStr === filterDate;
            }

            return matchSearch && matchCust && matchStatus && matchDate;
        }).sort((a, b) => {
            // Sort by timestamp if available for "newest input"
            const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            
            if (timeA !== timeB) return timeB - timeA;
            
            // Fallback to date
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });
    }, [invoices, search, filterCustomer, filterStatus, filterDate]);

    // Calculate pagination
    const totalPages = Math.ceil(filteredInvoices.length / itemsPerPage);
    const paginatedInvoices = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return filteredInvoices.slice(start, start + itemsPerPage);
    }, [filteredInvoices, currentPage]);

    const getStatusBadge = (invoice: Invoice) => {
        const statusType = getInvoiceStatusType(invoice);
        switch (statusType) {
            case 'Lunas':
                return <span className="px-2 py-0.5 text-[7px] md:text-[9px] font-black uppercase tracking-widest rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">Lunas</span>;
            case 'Sebagian':
                return <span className="px-2 py-0.5 text-[7px] md:text-[9px] font-black uppercase tracking-widest rounded-full bg-amber-50 text-amber-600 ring-1 ring-amber-100">Sebagian</span>;
            case 'Belum':
                return <span className="px-2 py-0.5 text-[7px] md:text-[9px] font-black uppercase tracking-widest rounded-full bg-rose-50 text-rose-600 ring-1 ring-rose-100">Belum Lunas</span>;
            default:
                return null;
        }
    };

    const handleDownloadXLSX = () => {
        const data = filteredInvoices.map(inv => {
            const totalTagihan = inv.subtotal + (customerDebts 
                ? Math.max(0, (customerDebts[inv.customer] || 0) - (inv.subtotal - inv.amountPaid))
                : Math.max(0, inv.previousDebt));
            
            return {
                'Nomor Invoice': inv.id,
                'Tanggal': new Date(inv.date).toLocaleDateString('id-ID', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'}),
                'Customer': inv.customer,
                'Subtotal': inv.subtotal,
                'Hutang Sebelumnya': (customerDebts 
                    ? Math.max(0, (customerDebts[inv.customer] || 0) - (inv.subtotal - inv.amountPaid))
                    : Math.max(0, inv.previousDebt)),
                'Total Tagihan': totalTagihan,
                'Status': getInvoiceStatusType(inv)
            };
        });

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Invoices");
        
        // Auto-size columns
        const maxWidths = Object.keys(data[0] || {}).map(key => {
            return Math.max(key.length, ...data.map(row => String((row as any)[key]).length));
        });
        worksheet["!cols"] = maxWidths.map(w => ({ wch: w + 2 }));

        XLSX.writeFile(workbook, `Daftar_Invoice_${new Date().toISOString().slice(0,10)}.xlsx`);
    };
    
    return (
        <div className="bg-white p-5 md:p-8 rounded-2xl md:rounded-[2.5rem] border border-slate-100 shadow-sm space-y-5 md:space-y-8 animate-in fade-in duration-500">
            {/* Header & Filter Bar */}
            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-base md:text-xl font-black text-slate-900 tracking-tighter uppercase leading-none">Daftar Invoice</h2>
                        <p className="text-[7px] md:text-[9px] text-slate-400 font-bold tracking-[0.2em] uppercase mt-1">Manajemen Penagihan Pelanggan</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button 
                            onClick={handleDownloadXLSX}
                            className="px-3 py-1.5 md:px-5 md:py-2.5 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg md:rounded-xl text-[8px] md:text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-emerald-100 flex items-center gap-2"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                            DOWNLOAD XLSX
                        </button>
                        <button 
                            onClick={handleReset}
                            className="px-3 py-1.5 md:px-5 md:py-2.5 bg-slate-50 border border-slate-200 text-slate-400 hover:text-slate-600 rounded-lg md:rounded-xl text-[8px] md:text-[10px] font-black uppercase tracking-widest transition-all"
                        >
                            RESET FILTER
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 md:p-5 bg-slate-50/50 rounded-2xl md:rounded-3xl border border-slate-100">
                    <div className="col-span-2 md:col-span-1">
                        <label className="block text-[7px] md:text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-1">Cari No. Invoice</label>
                        <input 
                            type="text" 
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="INV/..."
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold focus:ring-4 focus:ring-indigo-500/5 outline-none transition-all h-[38px]"
                        />
                    </div>
                    <div>
                        <label className="block text-[7px] md:text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-1">Pelanggan</label>
                        <SearchableCustomerFilter 
                            options={uniqueCustomers}
                            value={filterCustomer}
                            onChange={setFilterCustomer}
                        />
                    </div>
                    <div>
                        <label className="block text-[7px] md:text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-1">Tanggal</label>
                        <input 
                            type="date" 
                            value={filterDate}
                            onChange={(e) => setFilterDate(e.target.value)}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold outline-none h-[38px]"
                        />
                    </div>
                    <div className="col-span-2 md:col-span-1">
                        <label className="block text-[7px] md:text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-1">Status</label>
                        <select 
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold outline-none h-[38px]"
                        >
                            <option value="all">Semua Status</option>
                            <option value="Lunas">Lunas</option>
                            <option value="Sebagian">Bayar Sebagian</option>
                            <option value="Belum">Belum Lunas</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto no-scrollbar border border-slate-50 rounded-2xl">
                <table className="min-w-full divide-y divide-slate-100">
                    <thead className="bg-slate-50">
                        <tr>
                            <th className="px-4 py-3 text-left text-[8px] font-black text-slate-400 uppercase tracking-widest">Nomor Invoice</th>
                            <th className="px-4 py-3 text-left text-[8px] font-black text-slate-400 uppercase tracking-widest">Tanggal</th>
                            <th className="px-4 py-3 text-left text-[8px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
                            <th className="px-4 py-3 text-right text-[8px] font-black text-slate-400 uppercase tracking-widest">Total Tagihan</th>
                            <th className="px-4 py-3 text-center text-[8px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                            <th className="px-4 py-3 text-right text-[8px] font-black text-slate-400 uppercase tracking-widest">Aksi</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-slate-50">
                        {paginatedInvoices.length === 0 ? (
                            <tr><td colSpan={6} className="px-4 py-12 text-center text-[9px] font-black text-slate-300 uppercase tracking-widest italic">Data tidak ditemukan</td></tr>
                        ) : (
                            paginatedInvoices.map((invoice) => (
                                <tr key={invoice.id} className="hover:bg-slate-50 transition-all group">
                                    <td className="px-4 py-4 whitespace-nowrap text-[10px] font-black text-slate-900 uppercase">{invoice.id}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-[9px] font-bold text-slate-500">{new Date(invoice.date).toLocaleDateString('id-ID', {day: '2-digit', month: 'short', timeZone: 'UTC'})}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-[10px] font-black text-slate-700 uppercase">{invoice.customer}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-[10px] text-slate-800 text-right font-black">
                                        {new Intl.NumberFormat('id-ID').format(
                                            invoice.subtotal + (customerDebts 
                                                ? Math.max(0, (customerDebts[invoice.customer] || 0) - (invoice.subtotal - invoice.amountPaid))
                                                : Math.max(0, invoice.previousDebt))
                                        )}
                                    </td>
                                    <td className="px-4 py-4 whitespace-nowrap text-center">{getStatusBadge(invoice)}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-right">
                                        <button 
                                            onClick={() => onSelectInvoice(invoice)} 
                                            className="px-2.5 py-1.5 bg-slate-900 text-white rounded-lg text-[8px] font-black uppercase tracking-widest transition-all active:scale-95"
                                        >
                                            DETAIL
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
            
            {/* Pagination Controls */}
            <div className="flex flex-col sm:flex-row justify-between items-center gap-4 pt-4 border-t border-slate-50">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                    MENAMPILKAN {paginatedInvoices.length} DARI {filteredInvoices.length} INVOICE
                </div>
                
                {totalPages > 1 && (
                    <div className="flex items-center gap-1.5">
                        <button 
                            disabled={currentPage === 1}
                            onClick={() => setCurrentPage(prev => prev - 1)}
                            className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 disabled:opacity-30 transition-all active:scale-95"
                        >
                            PREV
                        </button>
                        <div className="bg-purple-600 text-white px-4 py-2 rounded-xl text-[10px] font-black min-w-[60px] text-center shadow-lg shadow-purple-100">
                            {currentPage} / {totalPages}
                        </div>
                        <button 
                            disabled={currentPage === totalPages}
                            onClick={() => setCurrentPage(prev => prev + 1)}
                            className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 disabled:opacity-30 transition-all active:scale-95"
                        >
                            NEXT
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default InvoiceList;
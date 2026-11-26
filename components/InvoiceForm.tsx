import React, { useState, useMemo } from 'react';
import type { DeliveryOrder, Invoice } from '../types';
import { XIcon } from './icons';
import CurrencyInput from './CurrencyInput';

interface InvoiceFormProps {
    order?: DeliveryOrder;
    initialData?: Invoice;
    previousDebt: number;
    liveDebt?: number;
    onSubmit: (invoiceData: Omit<Invoice, 'id' | 'date' | 'timestamp'>[], isEdit?: boolean, useLiveDebt?: boolean) => Promise<void>;
    onCancel: () => void;
}

const InvoiceForm: React.FC<InvoiceFormProps> = ({ order, initialData, previousDebt, liveDebt, onSubmit, onCancel }) => {
    const isEdit = !!initialData;
    const [useLiveDebt, setUseLiveDebt] = useState(false);

    // Normalisasi item: Jika ada item yang sama dari SJ berbeda, gabungkan kuantitasnya
    const initialItems = useMemo(() => {
        let rawItems: any[] = [];
        if (order) {
            rawItems = order.receivedItems && order.receivedItems.length > 0 ? order.receivedItems : order.items;
        } else if (isEdit && initialData) {
            rawItems = initialData.items;
        }

        const map = new Map<string, number>();
        rawItems.forEach(item => {
            map.set(item.name, (map.get(item.name) || 0) + item.quantity);
        });

        return Array.from(map.entries()).map(([name, quantity]) => ({ name, quantity }));
    }, [order, initialData, isEdit]);

    const [itemsToInvoice, setItemsToInvoice] = useState(initialItems);

    const [prices, setPrices] = useState<{ [key: string]: number }>(() => {
        const basePrices = initialItems.reduce((acc, item) => ({ ...acc, [item.name]: 0 }), {});
        if (isEdit && initialData) {
            const existingPrices = initialData.items.reduce((acc, item) => ({ ...acc, [item.name]: item.price }), {});
            return { ...basePrices, ...existingPrices };
        }
        return basePrices;
    });

    // Sync state when initialItems changes (e.g. when order is updated with new items)
    React.useEffect(() => {
        setItemsToInvoice(initialItems);
        setPrices(prev => {
            const basePrices = initialItems.reduce((acc, item) => ({ ...acc, [item.name]: 0 }), {});
            const currentPrices = { ...basePrices, ...prev };
            if (isEdit && initialData) {
                const existingPrices = initialData.items.reduce((acc, item) => ({ ...acc, [item.name]: item.price }), {});
                return { ...currentPrices, ...existingPrices };
            }
            return currentPrices;
        });
    }, [initialItems, isEdit, initialData]);

    const [transferAmount, setTransferAmount] = useState(initialData?.transfer || 0);
    const [cashAmount, setCashAmount] = useState(initialData?.cash || 0);
    const [keterangan, setKeterangan] = useState(() => {
        let ket = initialData?.keterangan || '';
        if (isEdit && ket) {
            ket = ket.replace('[REKAMAN]', '').trim();
        }
        return ket;
    });

    const handlePriceChange = (itemName: string, val: string) => {
        setPrices(prev => ({ ...prev, [itemName]: parseFloat(val) || 0 }));
    };

    const handleQuantityChange = (itemName: string, val: string) => {
        setItemsToInvoice(prev => prev.map(item =>
            item.name === itemName ? { ...item, quantity: parseFloat(val) || 0 } : item
        ));
    };

    const totalSubtotal = useMemo(() => {
        return itemsToInvoice.reduce((sum, item) => sum + (item.quantity * (prices[item.name] || 0)), 0);
    }, [itemsToInvoice, prices]);

    const activePreviousDebt = useLiveDebt ? (Number(liveDebt) || 0) : Number(previousDebt);
    const displayPreviousDebt = Math.max(0, activePreviousDebt);
    const totalBill = totalSubtotal + displayPreviousDebt;
    const totalPaid = (Number(transferAmount) || 0) + (Number(cashAmount) || 0);

    const invoiceStatus = useMemo(() => {
        if (totalBill <= 0) return 'Paid';
        if (totalPaid >= totalBill) return 'Paid';
        if (totalPaid > 0) return 'Partial';
        return 'Unpaid';
    }, [totalPaid, totalBill]);

    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isSubmitting) return;
        const hasMissingPrice = itemsToInvoice.some(item => prices[item.name] === undefined || prices[item.name] === null || isNaN(prices[item.name]));
        if (hasMissingPrice) {
            alert('Mohon isi harga untuk semua item.');
            return;
        }

        setIsSubmitting(true);
        // deliveryOrderId di sini bisa berupa satu ID atau beberapa (comma separated)
        const currentDOID = isEdit ? initialData!.deliveryOrderId : order!.id;
        const currentCustomer = isEdit ? initialData!.customer : order!.customer;
        const currentAddress = isEdit ? initialData!.customerAddress : (order!.customerAddress || '');

        const invoicesData: Omit<Invoice, 'id' | 'date' | 'timestamp'>[] = itemsToInvoice.map(item => ({
            deliveryOrderId: currentDOID,
            customer: currentCustomer,
            customerAddress: currentAddress,
            itemName: item.name,
            items: [{ name: item.name, quantity: item.quantity, price: prices[item.name], total: item.quantity * prices[item.name] }],
            subtotal: item.quantity * prices[item.name],
            previousDebt: activePreviousDebt,
            totalAmount: totalBill,
            transfer: transferAmount,
            cash: cashAmount,
            amountPaid: totalPaid,
            newDebt: Math.max(0, totalBill - totalPaid),
            qtyDiterima: item.quantity,
            keterangan: keterangan,
            status: invoiceStatus,
            paymentMethod: (transferAmount > 0 && cashAmount > 0) ? 'Transfer & Cash' : transferAmount > 0 ? 'Transfer' : cashAmount > 0 ? 'Cash' : '-',
            editInvoiceId: isEdit ? initialData!.id : undefined
        }));

        try {
            await onSubmit(invoicesData, isEdit, useLiveDebt);
        } finally {
            setIsSubmitting(false);
        }
    };

    const inputClasses = "mt-1 block w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm font-bold";

    return (
        <div className="fixed inset-0 bg-slate-900/75 backdrop-blur-sm overflow-y-auto h-full w-full z-[300] flex justify-center items-center p-4">
            <form onSubmit={handleSubmit} className="bg-white p-6 rounded-[2.5rem] shadow-2xl w-full max-w-2xl max-h-[95vh] flex flex-col border border-slate-200">
                <div className="flex justify-between items-center mb-6">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 tracking-tighter uppercase leading-none">
                            {isEdit ? 'Edit Invoice' : 'Buat Invoice'}
                        </h2>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">SJ: {isEdit ? initialData.deliveryOrderId : order?.id}</p>
                    </div>
                    <button onClick={onCancel} type="button" className="p-2 text-slate-300 hover:text-slate-600 transition-colors"><XIcon /></button>
                </div>

                <div className="flex-grow overflow-y-auto pr-2 space-y-6 no-scrollbar">
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Nama Customer</p>
                        <p className="font-black text-slate-800 text-lg uppercase">{isEdit ? initialData.customer : order?.customer}</p>
                    </div>

                    <div className="space-y-3">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Rincian Harga Item</h3>
                        {itemsToInvoice.map(item => (
                            <div key={item.name} className="grid grid-cols-3 gap-4 items-center bg-white p-3 rounded-2xl border border-slate-100 shadow-sm">
                                <div className="col-span-1">
                                    <p className="text-xs font-black text-slate-700 uppercase leading-tight">{item.name}</p>
                                    <div className="relative mt-1">
                                        <input
                                            type="number"
                                            step="0.01"
                                            value={item.quantity || ''}
                                            onChange={e => handleQuantityChange(item.name, e.target.value)}
                                            className="w-full pr-7 pl-2 py-1 bg-indigo-50 border border-indigo-100 rounded-lg text-[10px] font-black focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all"
                                            placeholder="0"
                                        />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-black text-indigo-400">Kg</span>
                                    </div>
                                </div>
                                <div className="col-span-2">
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-slate-300">Rp</span>
                                        <CurrencyInput
                                            value={prices[item.name]}
                                            onChange={val => handlePriceChange(item.name, val.toString())}
                                            className="w-full pl-9 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black focus:ring-4 focus:ring-red-500/5 outline-none transition-all"
                                            placeholder="0"
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {!isEdit && (
                        <div className="grid grid-cols-2 gap-4 border-t pt-6">
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Bayar Transfer (Rp)</label>
                                <CurrencyInput
                                    value={transferAmount || ''}
                                    onChange={val => setTransferAmount(parseFloat(val.toString()) || 0)}
                                    className={inputClasses}
                                    placeholder="0"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Bayar Cash (Rp)</label>
                                <CurrencyInput
                                    value={cashAmount || ''}
                                    onChange={val => setCashAmount(parseFloat(val.toString()) || 0)}
                                    className={inputClasses}
                                    placeholder="0"
                                />
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Keterangan Tambahan</label>
                        <textarea
                            value={keterangan}
                            onChange={e => setKeterangan(e.target.value)}
                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold focus:ring-4 focus:ring-red-500/5 outline-none"
                            rows={2}
                            placeholder="Catatan untuk invoice..."
                        />
                    </div>

                    <div className="bg-slate-900 text-white p-6 rounded-[2rem] shadow-xl">
                        <div className="flex justify-between text-[10px] font-black uppercase tracking-widest opacity-50 mb-1">
                            <span>Subtotal Barang:</span>
                            <span>{new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(totalSubtotal)}</span>
                        </div>
                        <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest mb-4">
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="liveDebtCheck"
                                    checked={useLiveDebt}
                                    onChange={(e) => setUseLiveDebt(e.target.checked)}
                                    className="w-3.5 h-3.5 accent-red-600 cursor-pointer"
                                />
                                <label htmlFor="liveDebtCheck" className="opacity-60 cursor-pointer select-none">
                                    Sisa Bon ({useLiveDebt ? 'Live' : 'Rekaman'}):
                                </label>
                            </div>
                            <span className={useLiveDebt ? 'text-yellow-400' : 'opacity-60'}>
                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(displayPreviousDebt)}
                            </span>
                        </div>
                        <div className="flex justify-between items-end border-t border-white/10 pt-4">
                            <span className="text-xs font-black uppercase tracking-widest">GRAND TOTAL:</span>
                            <span className="text-2xl font-black text-yellow-400 leading-none">
                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(totalBill)}
                            </span>
                        </div>
                        <div className="flex justify-between items-center mt-5">
                            <span className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40">Status Keuangan:</span>
                            <span className={`px-4 py-1.5 rounded-full font-black uppercase text-[10px] tracking-widest ${invoiceStatus === 'Paid' ? 'bg-emerald-500 text-white' : 'bg-orange-500 text-white'}`}>{invoiceStatus}</span>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end pt-6 border-t border-slate-100 mt-6 gap-3">
                    <button type="button" onClick={onCancel} className="px-6 py-3 bg-slate-100 text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all">BATAL</button>
                    <button type="submit" disabled={isSubmitting} className={`px-8 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg transition-all active:scale-95 ${isSubmitting ? 'bg-red-400 text-white cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700 shadow-red-100'}`}>
                        {isSubmitting ? 'MENYIMPAN...' : (isEdit ? 'UPDATE INVOICE' : 'SIMPAN INVOICE')}
                    </button>
                </div>
            </form>
        </div>
    );
};

export default InvoiceForm;
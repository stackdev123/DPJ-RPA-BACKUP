import React, { useState, useCallback } from 'react';
import type { LedgerEntry } from '../types';
import { XIcon, UploadIcon } from './icons';
import CurrencyInput from './CurrencyInput';
import { compressImageToBase64 } from '../imageUtils';

interface DebtPaymentFormProps {
    customerName: string;
    currentDebt: number;
    // Fix: Omit 'timestamp' to match the handler in LedgerView.tsx
    onSubmit: (paymentData: Omit<LedgerEntry, 'id' | 'balance' | 'debit' | 'timestamp'>) => void;
    onCancel: () => void;
}

const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value);
};


const DebtPaymentForm: React.FC<DebtPaymentFormProps> = ({ customerName, currentDebt, onSubmit, onCancel }) => {
    const [amount, setAmount] = useState(0);
    const [paymentMethod, setPaymentMethod] = useState<'Transfer' | 'Cash'>('Transfer');
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [notes, setNotes] = useState('');
    const [paymentProof, setPaymentProof] = useState<string | undefined>(undefined);
    const [fileName, setFileName] = useState('');

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (file.size > 10 * 1024 * 1024) { // 10MB raw limit before compression
                alert("Ukuran file terlalu besar. Maksimal 10MB.");
                return;
            }
            try {
                const base64 = await compressImageToBase64(file, 1024, 0.7);
                setPaymentProof(base64);
                setFileName(file.name);
            } catch (error) {
                console.error("Error compressing file to base64", error);
                alert("Gagal memproses file.");
            }
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (amount <= 0) {
            alert("Jumlah pembayaran harus lebih dari nol.");
            return;
        }
        if (amount > currentDebt) {
            if (!window.confirm("Jumlah pembayaran melebihi total hutang. Lanjutkan?")) {
                return;
            }
        }

        const description = notes.trim()
            ? `Pembayaran Hutang (${notes})`
            : `Pembayaran Hutang ${paymentMethod}`;

        // Fix: Call onSubmit without timestamp as it is now omitted from the type
        onSubmit({
            customerId: customerName,
            date: new Date(date),
            description,
            credit: amount,
            paymentMethod,
            paymentProof,
        });
    };

    return (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 overflow-y-auto h-full w-full z-50 flex justify-center items-center p-4">
            <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-xl w-full max-w-lg max-h-[95vh] flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-bold text-gray-800">Pembayaran Hutang</h2>
                    <button onClick={onCancel} type="button" className="text-gray-400 hover:text-gray-600"><XIcon /></button>
                </div>

                <div className="flex-grow overflow-y-auto pr-2 space-y-4">
                    <div>
                        <p className="text-sm text-gray-600">Pelanggan:</p>
                        <p className="text-lg font-semibold text-gray-800">{customerName}</p>
                        <p className="text-sm text-red-600">Total Sisa Hutang: {formatCurrency(currentDebt)}</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="payment-date" className="block text-sm font-medium text-gray-700">Tanggal Bayar</label>
                            <input
                                type="date"
                                id="payment-date"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="payment-method" className="block text-sm font-medium text-gray-700">Metode Bayar</label>
                            <select
                                id="payment-method"
                                value={paymentMethod}
                                onChange={(e) => setPaymentMethod(e.target.value as any)}
                                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                            >
                                <option value="Transfer">Transfer</option>
                                <option value="Cash">Cash</option>
                            </select>
                        </div>
                    </div>
                    
                    <div>
                        <label htmlFor="payment-amount" className="block text-sm font-medium text-gray-700">Jumlah Pembayaran (Rp)</label>
                        <CurrencyInput
                            id="payment-amount"
                            value={amount === 0 ? '' : amount}
                            onChange={(val) => setAmount(Number(val))}
                            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                            placeholder="0"
                            required
                        />
                    </div>

                    {paymentMethod === 'Transfer' && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700">Bukti Transfer</label>
                            <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-md">
                                <div className="space-y-1 text-center">
                                    <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                                        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                    <div className="flex text-sm text-gray-600">
                                        <label htmlFor="file-upload" className="relative cursor-pointer bg-white rounded-md font-medium text-blue-600 hover:text-blue-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500">
                                            <span>Unggah file</span>
                                            <input id="file-upload" name="file-upload" type="file" className="sr-only" accept="image/png, image/jpeg, image/gif" onChange={handleFileChange} />
                                        </label>
                                        <p className="pl-1">atau seret dan lepas</p>
                                    </div>
                                    <p className="text-xs text-gray-500">PNG, JPG, GIF hingga 10MB (kompresi otomatis)</p>
                                     {fileName && <p className="text-xs text-green-600 mt-2 font-semibold">{fileName}</p>}
                                </div>
                            </div>
                        </div>
                    )}
                     <div>
                        <label htmlFor="payment-notes" className="block text-sm font-medium text-gray-700">Catatan (Opsional)</label>
                        <textarea
                            id="payment-notes"
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                            placeholder="Contoh: Pembayaran cicilan pertama"
                        />
                    </div>
                </div>

                <div className="flex justify-end pt-4 border-t mt-4">
                    <button type="button" onClick={onCancel} className="bg-gray-200 text-gray-800 py-2 px-4 rounded-md mr-2 hover:bg-gray-300">Batal</button>
                    <button type="submit" className="py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700">Simpan Pembayaran</button>
                </div>
            </form>
        </div>
    );
};

export default DebtPaymentForm;
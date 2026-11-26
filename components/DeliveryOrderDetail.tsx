import React, { useState, useMemo } from 'react';
import download from 'downloadjs';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { DeliveryOrder, AllocationItem, MasterItem } from '../types';
import { PrintIcon, DownloadIcon, XIcon } from './icons';

interface DeliveryOrderDetailProps {
    order: DeliveryOrder;
    masterItems: MasterItem[];
    onClose: () => void;
    onUpdateOrder: (updatedOrder: DeliveryOrder) => void;
    onStartInvoicing: (order: DeliveryOrder) => void;
}

interface ReceptionItem {
    name: string;
    sent: number;
    received: number;
    rejected: number;
}

const DeliveryOrderDetail: React.FC<DeliveryOrderDetailProps> = ({ order, masterItems = [], onClose, onUpdateOrder, onStartInvoicing }) => {
    const [isReceiving, setIsReceiving] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [previewImages, setPreviewImages] = useState<{data: string, name: string}[] | null>(null);
    
    const [newItemName, setNewItemName] = useState('');
    const [newItemSent, setNewItemSent] = useState('');
    const [newItemReceived, setNewItemReceived] = useState('');
    const [newItemRejected, setNewItemRejected] = useState('');

    const [receptionData, setReceptionData] = useState<ReceptionItem[]>(() => 
        order.items.map(item => {
            const receivedItem = order.receivedItems?.find(ri => ri.name === item.name);
            const rejectedItem = order.rejectedItems?.find(ri => ri.name === item.name);
            return {
                name: item.name,
                sent: item.quantity,
                received: receivedItem?.quantity ?? item.quantity,
                rejected: rejectedItem?.quantity ?? 0,
            };
        })
    );
    
    const startReceiving = () => { setIsReceiving(true); };

    const handleReceptionChange = (name: string, field: 'sent' | 'received' | 'rejected', value: string) => {
        const quantity = parseFloat(value);
        const itemToUpdate = receptionData.find(i => i.name === name);
        if (!itemToUpdate) return;
        
        let validQuantity = 0;
        if (!isNaN(quantity)) { validQuantity = Math.max(0, quantity); }

        setReceptionData(prev => 
            prev.map(item => 
                item.name === name 
                    ? { ...item, [field]: validQuantity } 
                    : item
            )
        );
    };

    const handleConfirmReceive = () => {
        const receivedItems: AllocationItem[] = receptionData
            .filter(item => item.received > 0)
            .map(item => ({ name: item.name, quantity: item.received }));
        
        const rejectedItems: AllocationItem[] = receptionData
            .filter(item => item.rejected > 0)
            .map(item => ({ name: item.name, quantity: item.rejected }));

        const updatedBaseItems: AllocationItem[] = receptionData
            .filter(item => item.sent > 0 || item.received > 0 || item.rejected > 0)
            .map(item => ({ name: item.name, quantity: item.sent }));

        const updatedOrder: DeliveryOrder = {
            ...order,
            items: updatedBaseItems,
            status: 'received',
            receivedItems,
            rejectedItems,
        };
        onUpdateOrder(updatedOrder);
        setIsReceiving(false);
    }

    const handleAddNewItem = () => {
        if (!newItemName.trim()) return alert("Nama barang harus diisi");
        const sent = parseFloat(newItemSent) || 0;
        const received = parseFloat(newItemReceived) || 0;
        const rejected = parseFloat(newItemRejected) || 0;
        
        if (receptionData.some(i => i.name === newItemName.trim())) {
            return alert("Barang sudah ada di daftar");
        }

        setReceptionData([...receptionData, {
            name: newItemName.trim(),
            sent,
            received,
            rejected
        }]);

        setNewItemName('');
        setNewItemSent('');
        setNewItemReceived('');
        setNewItemRejected('');
    };

    const itemChunks = useMemo(() => {
        const chunks = [];
        const items = order.items || [];
        const chunkSize = 10;
        
        if (items.length === 0) {
            const emptyChunk = Array(chunkSize).fill(null);
            chunks.push(emptyChunk);
            return chunks;
        }

        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            while (chunk.length < chunkSize) {
                chunk.push(null as any);
            }
            chunks.push(chunk);
        }
        return chunks;
    }, [order.items]);
    
    const handlePrint = () => { window.print(); };
    
    const generateCanvas = async (elementId: string) => {
        const printArea = document.getElementById(elementId);
        if (!printArea) return null;

        try {
            return await html2canvas(printArea, {
                scale: 4, // resolusi tinggi
                backgroundColor: "#ffffff",
                useCORS: true,
                width: printArea.offsetWidth,
                height: printArea.offsetHeight,
                windowWidth: printArea.offsetWidth,
                windowHeight: printArea.offsetHeight,
                scrollX: 0,
                scrollY: 0,
                onclone: (doc) => {
                    const el = doc.getElementById(elementId);
                    if (el) {
                        el.style.transform = "none";
                    }
                }
            });
        } catch (error) {
            console.error("Error in generateCanvas:", error);
            throw error;
        }
    };

    const handleDownload = async () => {
        setIsDownloading(true);
        
        const scrollContainer = document.querySelector('.overflow-y-auto');
        const originalScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        if (scrollContainer) scrollContainer.scrollTop = 0;

        const printPages = document.querySelectorAll('.print-page');
        printPages.forEach(page => {
            page.classList.remove('scale-[0.8]', 'sm:scale-100');
            (page as HTMLElement).style.transform = 'none';
        });

        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await document.fonts.ready;
            const pdf = new jsPDF({ 
                orientation: 'landscape', 
                unit: 'mm', 
                format: 'a5',
                compress: true 
            });
            
            for (let i = 0; i < itemChunks.length; i++) {
                const canvas = await generateCanvas(`print-page-${i}`);
                if (!canvas) continue;
                
                const imgData = canvas.toDataURL('image/jpeg', 1.0);
                
                if (i > 0) {
                    pdf.addPage();
                }
                pdf.addImage(imgData, 'JPEG', 0, 0, 210, 148, undefined, 'FAST');
            }
            
            const pdfBlob = pdf.output('blob');
            download(pdfBlob, `SJ-${order.id.replace(/\//g, '-')}.pdf`, "application/pdf");
        } catch (error) {
            console.error(error);
            alert("Gagal mengunduh PDF.");
        } finally {
            printPages.forEach(page => {
                page.classList.add('scale-[0.8]', 'sm:scale-100');
                (page as HTMLElement).style.transform = '';
            });
            if (scrollContainer) scrollContainer.scrollTop = originalScrollTop;
            setIsDownloading(false);
        }
    };

    const handleDownloadJPG = async () => {
        setIsDownloading(true);
        
        const scrollContainer = document.querySelector('.overflow-y-auto');
        const originalScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        if (scrollContainer) scrollContainer.scrollTop = 0;

        const printPages = document.querySelectorAll('.print-page');
        printPages.forEach(page => {
            page.classList.remove('scale-[0.8]', 'sm:scale-100');
            (page as HTMLElement).style.transform = 'none';
        });

        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await document.fonts.ready;
            const images = [];
            for (let i = 0; i < itemChunks.length; i++) {
                const canvas = await generateCanvas(`print-page-${i}`);
                if (!canvas) continue;
                
                const imgData = canvas.toDataURL('image/jpeg', 0.98);
                const name = itemChunks.length > 1 
                    ? `SJ-${order.id.replace(/\//g, '-')}-hal-${i+1}.jpg`
                    : `SJ-${order.id.replace(/\//g, '-')}.jpg`;
                images.push({ data: imgData, name });
            }
            setPreviewImages(images);
        } catch (error) {
            alert("Gagal membuat preview JPG.");
        } finally {
            printPages.forEach(page => {
                page.classList.add('scale-[0.8]', 'sm:scale-100');
                (page as HTMLElement).style.transform = '';
            });
            if (scrollContainer) scrollContainer.scrollTop = originalScrollTop;
            setIsDownloading(false);
        }
    };

    const confirmDownloadJPG = async () => {
        if (!previewImages) return;
        for (let i = 0; i < previewImages.length; i++) {
            download(previewImages[i].data, previewImages[i].name, "image/jpeg");
            if (i < previewImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        setPreviewImages(null);
    };

    return (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm overflow-y-auto h-full w-full z-[1000] flex justify-center items-start pt-4 md:pt-10 pb-20 md:pb-32 print:static print:bg-white print:block print:p-0 print:overflow-visible">
            <div className="relative bg-white rounded-3xl shadow-2xl flex flex-col w-[96%] md:w-auto print:static print:shadow-none print:rounded-none print:p-0 print:overflow-visible">
                
                <div id="print-area" className="overflow-x-auto no-scrollbar bg-slate-50 md:bg-white p-2 md:p-4 rounded-t-3xl flex flex-col gap-8 print:block print:gap-0 print:p-0 print:bg-transparent print:overflow-visible">
                    {itemChunks.map((chunk, pageIndex) => (
                        <div 
                            key={pageIndex}
                            id={`print-page-${pageIndex}`}
                            className="print-page bg-white text-black mx-auto flex flex-col print:m-0 border-none shadow-none shrink-0 scale-[0.8] sm:scale-100 print:scale-100 print:transform-none origin-top-left sm:origin-center"
                            style={{ width: '800px', height: '564px', padding: '38px 30px 30px 30px', boxSizing: 'border-box', fontFamily: 'sans-serif', fontWeight: '400' }}
                        >
                            {/* HEADER SECTION */}
                            <div className="flex justify-between items-end mb-1" style={{ marginBottom: '4px', paddingBottom: '3px' }}>
                                <h1 style={{ fontSize: '32px', fontWeight: '900', lineHeight: '1.2', margin: '0', textTransform: 'uppercase', letterSpacing: '-1px' }}>SURAT JALAN</h1>
                                <div className="flex items-center gap-4">
                                    <div style={{ fontSize: '10px', textAlign: 'right', fontWeight: '400', lineHeight: '1.2' }}>
                                        <p style={{ margin: 0 }}>Kp. Pangkalan No. 436, Desa Pangkalan</p>
                                        <p style={{ margin: 0 }}>Kec. Bojong, Kab. Purwakarta</p>
                                        <p style={{ margin: 0 }}>Jawa Barat 41164</p>
                                    </div>
                                    <img src="/logo.png" alt="Logo" style={{ height: '42px', width: 'auto' }} />
                                </div>
                            </div>

                            <div style={{ borderTop: '2px solid black', marginBottom: '6px', width: '100%' }}></div>

                            {/* INFO SECTION */}
                            <div className="flex justify-between items-start mb-2 gap-4">
                                <div style={{ border: '1px solid black', width: '48%', height: '58px', padding: '0px 10px', boxSizing: 'border-box' }}>
                                    <p style={{ fontSize: '11px', fontWeight: '400', margin: '0', color: '#000', paddingBottom: '0px' }}>Alamat kirim :</p>
                                    <p style={{ fontSize: '16px', fontWeight: '400', margin: '0', textTransform: 'uppercase', lineHeight: '1.1', paddingBottom: '0px' }}>{order.customer}</p>
                                    <p style={{ fontSize: '10px', margin: '0', lineHeight: '1.2', paddingBottom: '0px' }}>{order.customerAddress || ''}</p>
                                </div>
                                
                                <table style={{ width: '48%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                                    <tbody>
                                        <tr style={{ height: '22px' }}>
                                            <td style={{ border: '1px solid black', textAlign: 'center', fontSize: '11px', fontWeight: '400', width: '50%', backgroundColor: 'transparent', paddingBottom: '0px', paddingRight: '1px', paddingTop: '0px' }}>Nomor SJ</td>
                                            <td style={{ border: '1px solid black', textAlign: 'center', fontSize: '11px', fontWeight: '400', width: '50%', backgroundColor: 'transparent', paddingBottom: '0px', paddingRight: '1px', paddingTop: '0px' }}>Tanggal</td>
                                        </tr>
                                        <tr style={{ height: '35px' }}>
                                            <td style={{ border: '1px solid black', textAlign: 'center', fontSize: '13px', fontWeight: '400', verticalAlign: 'middle' }}>{order.id}{itemChunks.length > 1 ? ` (Hal ${pageIndex + 1}/${itemChunks.length})` : ''}</td>
                                            <td style={{ border: '1px solid black', textAlign: 'center', fontSize: '13px', fontWeight: '400', verticalAlign: 'middle' }}>
                                                {order.date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase()}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>

                            {/* MAIN ITEMS TABLE */}
                            <div style={{ border: '1px solid black', flexGrow: 1, overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ height: '26px', borderBottom: '1px solid black', backgroundColor: 'transparent' }}>
                                            <th style={{ borderRight: '1px solid black', fontSize: '11px', fontWeight: '400', width: '40px', textAlign: 'center', paddingBottom: '2px' }}>No</th>
                                            <th style={{ borderRight: '1px solid black', fontSize: '11px', fontWeight: '400', textAlign: 'center', paddingLeft: '0px', width: '35%', paddingBottom: '2px', paddingTop: '0px' }}>Nama Barang</th>
                                            <th style={{ borderRight: '1px solid black', fontSize: '11px', fontWeight: '400', width: '85px', textAlign: 'center', paddingBottom: '2px' }}>Kirim Kg</th>
                                            <th style={{ borderRight: '1px solid black', fontSize: '11px', fontWeight: '400', width: '85px', textAlign: 'center', paddingBottom: '2px' }}>Terima Kg</th>
                                            <th style={{ borderRight: '1px solid black', fontSize: '11px', fontWeight: '400', width: '85px', textAlign: 'center', paddingBottom: '2px' }}>Tolak/Retur</th>
                                            <th style={{ fontSize: '11px', fontWeight: '400', width: '100px', textAlign: 'center', paddingBottom: '2px' }}>Keterangan</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {chunk.map((item, index) => {
                                            const received = order.receivedItems?.find(ri => ri.name === item?.name)?.quantity;
                                            const rejected = order.rejectedItems?.find(ri => ri.name === item?.name)?.quantity;
                                            const globalIndex = pageIndex * 10 + index + 1;
                                            return (
                                                <tr key={index} style={{ height: '26px' }}>
                                                    <td style={{ borderRight: '1px solid black', textAlign: 'center', fontSize: '11px', fontWeight: '400', paddingLeft: '1px', paddingTop: '1px', paddingBottom: '2px' }}>{item ? globalIndex : ''}</td>
                                                    <td style={{ borderRight: '1px solid black', fontSize: '11px', paddingLeft: '12px', textTransform: 'uppercase', fontWeight: '400', paddingBottom: '2px' }}>{item?.name || ''}</td>
                                                    <td style={{ borderRight: '1px solid black', textAlign: 'center', fontSize: '12px', fontStyle: 'italic', fontWeight: '400', paddingBottom: '2px' }}>{item?.quantity || ''}</td>
                                                    <td style={{ borderRight: '1px solid black', textAlign: 'center', fontSize: '12px', fontStyle: 'italic', fontWeight: '400', paddingBottom: '2px' }}>{received || ''}</td>
                                                    <td style={{ borderRight: '1px solid black', textAlign: 'center', fontSize: '12px', fontStyle: 'italic', fontWeight: '400', paddingBottom: '2px' }}>{rejected || ''}</td>
                                                    <td style={{ paddingBottom: '2px' }}></td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {/* SIGNATURE SECTION */}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                                <table style={{ width: '65%', borderCollapse: 'collapse', border: '1px solid black' }}>
                                    <thead>
                                        <tr style={{ height: '22px', fontSize: '11px', textAlign: 'center', backgroundColor: 'transparent' }}>
                                            <td style={{ borderRight: '1px solid black', width: '33%', fontWeight: '400' }}>Disiapkan Oleh</td>
                                            <td style={{ borderRight: '1px solid black', width: '33%', fontWeight: '400' }}>Dikirim Oleh</td>
                                            <td style={{ width: '33%', fontWeight: '400' }}>Diterima Oleh</td>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr style={{ height: '60px' }}>
                                            <td style={{ borderRight: '1px solid black', verticalAlign: 'top' }}></td>
                                            <td style={{ borderRight: '1px solid black', verticalAlign: 'top' }}></td>
                                            <td style={{ verticalAlign: 'top' }}></td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}
                </div>

                {!isReceiving ? (
                    <div className="flex flex-col md:flex-row md:justify-between md:items-center mt-2 md:mt-4 pt-6 print:hidden px-4 md:px-10 pb-10 border-t bg-white gap-4 rounded-b-3xl">
                        <div className="flex flex-wrap gap-3">
                            <button onClick={startReceiving} className="flex-1 md:flex-none bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest px-8 py-4 rounded-2xl hover:bg-emerald-600 transition-all shadow-lg active:scale-95">
                                {order.status === 'pending' ? 'Input Terima Real' : 'Edit Penerimaan'}
                            </button>
                            {(order.status === 'received' || order.status === 'revised') && (
                                <button
                                    onClick={() => onStartInvoicing(order)}
                                    disabled={!!order.invoiceId}
                                    className="flex-1 md:flex-none bg-purple-600 text-white font-black text-[10px] uppercase tracking-widest px-8 py-4 rounded-2xl hover:bg-purple-700 disabled:bg-slate-200 transition-all shadow-lg active:scale-95"
                                >
                                    {order.invoiceId ? 'Invoice Selesai' : 'Buat Invoice'}
                                </button>
                            )}
                        </div>
                        
                        <div className="flex flex-wrap items-center justify-center md:justify-end gap-3">
                            <button onClick={handlePrint} className="w-[190px] justify-center flex items-center bg-slate-900 text-white font-black text-[10px] uppercase tracking-widest px-6 py-4 rounded-2xl hover:bg-slate-800 transition-all active:scale-95"><PrintIcon className="h-4 w-4 mr-2" />Cetak</button>
                            <button onClick={handleDownload} disabled={isDownloading} className="w-[190px] justify-center flex items-center bg-indigo-600 text-white font-black text-[10px] uppercase tracking-widest px-6 py-4 rounded-2xl hover:bg-indigo-700 transition-all disabled:bg-slate-200 active:scale-95"><DownloadIcon className="h-4 w-4 mr-2" />{isDownloading ? '...' : 'PDF'}</button>
                            <button onClick={handleDownloadJPG} disabled={isDownloading} className="w-[190px] justify-center flex items-center bg-sky-600 text-white font-black text-[10px] uppercase tracking-widest px-6 py-4 rounded-2xl hover:bg-sky-700 transition-all disabled:bg-slate-200 active:scale-95"><DownloadIcon className="h-4 w-4 mr-2" />{isDownloading ? '...' : 'JPG'}</button>
                            <button onClick={onClose} className="hidden md:block p-3 text-slate-300 hover:text-slate-900 transition-colors"><XIcon className="h-6 w-6" /></button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-2 border-t pt-6 px-4 md:px-10 bg-slate-50 pb-12 rounded-b-3xl print:hidden">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-xl font-black uppercase tracking-tighter text-slate-800">Konfirmasi Penerimaan Real</h3>
                            <button onClick={() => setIsReceiving(false)} className="text-slate-400 hover:text-slate-600 transition-colors"><XIcon className="h-5 w-5" /></button>
                        </div>
                        <div className="space-y-3 max-h-[350px] overflow-y-auto no-scrollbar pr-2 mb-8">
                            {receptionData.map(item => (
                                <div key={item.name} className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 bg-white rounded-2xl border border-slate-200 shadow-sm">
                                    <div className="flex-1 min-w-0">
                                        <div className="font-black text-xs uppercase text-slate-900 mb-1 leading-none">{item.name}</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-3 shrink-0">
                                        <div>
                                            <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Kirim</label>
                                            <input type="number" value={item.sent} onChange={(e) => handleReceptionChange(item.name, 'sent', e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all"/>
                                        </div>
                                        <div>
                                            <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Terima</label>
                                            <input type="number" value={item.received} onChange={(e) => handleReceptionChange(item.name, 'received', e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all"/>
                                        </div>
                                        <div>
                                            <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Retur</label>
                                            <input type="number" value={item.rejected} onChange={(e) => handleReceptionChange(item.name, 'rejected', e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-rose-500/10 transition-all text-rose-600"/>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            
                            {/* NEW ITEM FORM */}
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 bg-white rounded-2xl border border-dashed border-slate-300 shadow-sm">
                                <div className="flex-1 min-w-0">
                                    <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Nama Barang Baru</label>
                                    <input list="master-items" value={newItemName} onChange={(e) => setNewItemName(e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black uppercase outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" placeholder="PILIH BARANG" />
                                </div>
                                <div className="grid grid-cols-3 gap-3 shrink-0">
                                    <div>
                                        <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Kirim</label>
                                        <input type="number" value={newItemSent} onChange={(e) => setNewItemSent(e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" placeholder="0"/>
                                    </div>
                                    <div>
                                        <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Terima</label>
                                        <input type="number" value={newItemReceived} onChange={(e) => setNewItemReceived(e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all" placeholder="0"/>
                                    </div>
                                    <div>
                                        <label className="text-[8px] font-black text-slate-400 block uppercase mb-1 ml-1">Retur</label>
                                        <input type="number" value={newItemRejected} onChange={(e) => setNewItemRejected(e.target.value)} className="w-20 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-center font-black outline-none focus:ring-4 focus:ring-rose-500/10 transition-all text-rose-600" placeholder="0"/>
                                    </div>
                                </div>
                                <button onClick={handleAddNewItem} className="mt-4 sm:mt-0 px-4 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 shadow-lg transition-all active:scale-95 self-end sm:self-center">Tambah</button>
                            </div>
                        </div>
                        <datalist id="master-items">{masterItems.map(m => <option key={m.name} value={m.name} />)}</datalist>
                         <div className="flex justify-end gap-3 pt-6 border-t border-slate-200">
                            <button onClick={() => setIsReceiving(false)} className="px-8 py-4 bg-white border border-slate-200 text-slate-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 active:scale-95">Batal</button>
                            <button onClick={handleConfirmReceive} className="px-10 py-4 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 shadow-xl transition-all active:scale-95">Simpan Data</button>
                        </div>
                    </div>
                )}
            </div>
            <style>{`
                @media print {
                    @page { 
                        size: A5 landscape; 
                        margin: 0; 
                    }
                    body { -webkit-print-color-adjust: exact !important; }
                    body * { visibility: hidden; }
                    #print-area, #print-area * { visibility: visible; }
                    #print-area { 
                        width: 100% !important; 
                        margin: 0 !important; 
                    }
                    .print-page {
                        position: relative !important;
                        page-break-after: always;
                        width: 800px !important;
                        height: 564px !important;
                        margin: 0 !important;
                        transform: none !important;
                    }
                    .print-page:last-child {
                        page-break-after: auto;
                    }
                }
            `}</style>
            
            {previewImages && (
                <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[2000] flex flex-col items-center justify-center p-4 print:hidden">
                    <div className="bg-white rounded-3xl p-6 max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-black uppercase tracking-tighter text-slate-800">Preview JPG</h3>
                            <button onClick={() => setPreviewImages(null)} className="text-slate-400 hover:text-slate-600 transition-colors"><XIcon className="h-6 w-6" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto min-h-0 bg-slate-100 rounded-2xl p-4 flex flex-col gap-4 items-center">
                            {previewImages.map((img, idx) => (
                                <img key={idx} src={img.data} alt={`Preview ${idx + 1}`} className="max-w-full h-auto shadow-md rounded-lg border border-slate-200" />
                            ))}
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button onClick={() => setPreviewImages(null)} className="px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-slate-50 transition-all active:scale-95">Batal</button>
                            <button onClick={confirmDownloadJPG} className="px-8 py-3 bg-sky-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-sky-700 shadow-lg transition-all flex items-center active:scale-95"><DownloadIcon className="h-4 w-4 mr-2" /> Download JPG</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DeliveryOrderDetail;
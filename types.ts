export interface StockItem {
  name: string;
  quantity: number;
}

export interface MasterItem {
  id?: string;
  name: string;
}

export type ProductionItems = {
  [key: string]: number;
};

export interface Coop {
  id?: string;
  name: string;
  address: string;
}

export interface Customer {
  id?: string;
  name: string;
  address: string;
}

export interface TradingPurchaseRecord {
  supplier_name: string;
  nama_barang: string;
  kategori: string;
  catatan: string;
  id: string;
  tanggal: string;
  timestamp?: string;
  timestampMs?: number;
  item_name: string;
  kg: number;
  harga_per_kg: number;
  total_harga: number;
}

export interface StockDisposalRecord {
  nama_barang: string;
  catatan: string;
  id: string;
  tanggal: string;
  timestamp?: string;
  timestampMs?: number;
  item_name: string;
  kg: number;
  harga_valuasi_kg: number;
  total_kerugian: number;
  keterangan: string;
}

// Database: production_logs
export interface SupabaseProductionLog {
  id: string;
  tanggal_produksi: string;
  item_name: string;
  qty: number;
  timestamp: string;
  ekor: number;
  kg: number;
  mobil: string;
  plat: string;
  harga_beli_kg: number;
  kematian_ekor: number;
  kematian_kg: number;
  nama_kandang: string;
  driver: string;
  is_applied: boolean;
}

// Database: delivery_orders
export interface SupabaseDeliveryOrder {
  id: string;
  tanggal: string;
  nomor_sj: string;
  customer: string;
  nama_item: string;
  qty_kirim: number;
  qty_kirim2?: number;
  qty_diterima: number;
  qty_diterima2?: number;
  retur: number;
  susut_selisih: number;
  timestamp: string;
}

// Database: invoices
export interface SupabaseInvoice {
  id: string;
  tanggal: string;
  nomor_sj: string;
  timestamp: string;
  nomor_invoice: string;
  harga: number;
  total: number;
  transfer: number;
  cash: number;
  qty_diterima: number;
  keterangan: string;
  invoice_status: string;
  item_name: string; 
  customer: string;
}

export interface StockLog {
  id: string;
  timestamp: Date;
  timestampMs?: number;
  type: 'Produksi' | 'Alokasi' | 'Opname' | 'Pembelian' | 'Pemusnahan';
  itemName: string;
  stockBefore: number;
  change: number;
  stockAfter: number;
  notes?: string;
}

export interface AllocationItem {
  name: string;
  quantity: number;
}

export interface DeliveryOrder {
  id: string; 
  date: Date;
  dateMs?: number;
  customer: string;
  customerAddress?: string;
  items: AllocationItem[];
  receivedItems?: AllocationItem[];
  rejectedItems?: AllocationItem[];
  status: 'pending' | 'received' | 'revised';
  invoiceId?: string;
}

export interface ProductionRecord {
  plateNumber: string;
  driverName: string;
  failedChickenCount: number;
  successChickenCount: number;
  estimatedChickenCount: number;
  id: string;
  date: Date;
  dateMs?: number;
  dateStr?: string;
  truckNumber: number;
  coopName: string;
  driver: string;
  licensePlate: string;
  initialEkor: number;
  initialKg: number;
  mortality: number;
  mortalityKg: number;
  pricePerKg?: number;
  items: ProductionItems;
  isApplied?: boolean;
}

export interface ProductionLog {
  id: string;
  timestamp: Date;
  action: string;
  record: ProductionRecord;
}

export interface InvoiceItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
}

export interface Invoice {
  id: string; 
  date: Date;
  dateMs?: number;
  timestamp: string;
  timestampMs?: number;
  deliveryOrderId: string;
  customer: string;
  customerAddress: string;
  itemName: string; 
  items: InvoiceItem[]; 
  subtotal: number;
  previousDebt: number;
  totalAmount: number;
  transfer: number;
  cash: number;
  amountPaid: number;
  newDebt: number;
  qtyDiterima: number;
  keterangan: string;
  status: string;
  paymentMethod: string;
  editInvoiceId?: string;
  invoiceNumber?: string;
  customerName?: string;
  harga?: number;
  total?: number;
  nomor_invoice?: string;
}

export interface LedgerEntry {
  id: string;
  customerId: string;
  date: Date;
  dateMs?: number;
  timestamp: string;
  timestampMs?: number;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  paymentMethod?: 'Transfer' | 'Cash';
  paymentProof?: string;
}

export interface ExpenseRecord {
  id: string;
  date: Date;
  dateMs?: number;
  category: string;
  amount: number;
  description: string;
  proofImage?: string;
}

export interface SalaryRecord {
  role: string;
  id: string;
  date: Date;
  dateMs?: number;
  employeeName: string;
  dailyRate: number;
  daysWorked: number;
  cashBon: number;
  totalSalary: number;
  notes?: string;
}

// Fixed: Added missing PlasticItem and PlasticLog interfaces
export interface PlasticItem {
  name: string;
  quantity: number;
  unit: 'Pcs' | 'Kg';
}

export interface PlasticLog {
  id: string;
  date: Date;
  type: 'Pembelian' | 'Pengeluaran';
  itemName: string;
  quantity: number;
  unit: 'Pcs' | 'Kg';
  pricePerUnit?: number;
  totalCost?: number;
  notes?: string;
}

export interface ActivityLog {
  created_at: string;
  id: string;
  username: string;
  action: string;
  target_table: string;
  target_id?: string;
  details?: any;
  timestamp: string;
}

import type { DeliveryOrder } from './types';

const getApiBaseUrl = (): string => {
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) {
      return String((import.meta as any).env.VITE_API_URL).replace(/\/+$/, '');
    }
    if (typeof process !== 'undefined' && process.env?.VITE_API_URL) {
      return String(process.env.VITE_API_URL).replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return 'http://localhost:5000/api';
};

export const API_BASE_URL = getApiBaseUrl();

let authToken: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export const setAuthToken = (token: string | null) => {
  authToken = token;
};

export const hasAuthToken = (): boolean => Boolean(authToken);

export const clearAuthToken = () => {
  authToken = null;
};

export const setOnUnauthorized = (cb: (() => void) | null) => {
  onUnauthorizedCallback = cb;
};

async function apiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  } catch (networkErr: any) {
    const isRemotePreview =
      typeof window !== 'undefined' &&
      !['localhost', '127.0.0.1'].includes(window.location.hostname);
    throw new Error(
      isRemotePreview
        ? `Tidak dapat terhubung ke backend lokal (${API_BASE_URL}) dari preview cloud. Unduh proyek dan jalankan backend (cd backend && npm start) + frontend (npm run dev) secara lokal di komputer Windows Anda yang terhubung ke PostgreSQL dpj_rpa.`
        : `Tidak dapat terhubung ke server backend (${API_BASE_URL}). Pastikan backend berjalan di port 5000 (jalankan "cd backend && npm start").`
    );
  }

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      authToken = null;
      if (onUnauthorizedCallback) {
        onUnauthorizedCallback();
      }
    }
    const errMsg = data?.error || data?.message || `HTTP Error ${response.status}`;
    throw new Error(errMsg);
  }

  return data as T;
}

export const checkBackendHealth = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
};

export const db = {
  verifyUser: async (user: string, pass: string) => {
    const data = await apiFetch<{ id: string; user: string; role: string; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (data?.token) {
      setAuthToken(data.token);
    }
    return data || null;
  },

  addActivityLog: async (
    username: string,
    action: string,
    targetTable: string,
    targetId?: string,
    details?: any
  ) => {
    try {
      await apiFetch('/activity_logs', {
        method: 'POST',
        body: JSON.stringify({
          username,
          action,
          target_table: targetTable,
          target_id: targetId || null,
          details: details || null,
        }),
      });
    } catch (e) {
      console.error('Error adding activity log:', e);
    }
  },

  fetchActivityLogs: async (startDate?: string, endDate?: string, action?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (action) params.set('action', action);
    const qs = params.toString();
    return apiFetch<any[]>(`/activity_logs${qs ? `?${qs}` : ''}`);
  },

  getInitialData: async (_forceFull: boolean = false) => {
    return apiFetch<any>('/initial-data');
  },

  fetchTables: async (tableNames: string[], _forceFull: boolean = false): Promise<Record<string, any[]>> => {
    const uniqueTables = Array.from(new Set(tableNames)).filter(Boolean);
    if (uniqueTables.length === 0) return {};
    const params = new URLSearchParams({ names: uniqueTables.join(',') });
    return apiFetch<Record<string, any[]>>(`/tables?${params.toString()}`);
  },

  refreshSingleTable: async (tableName: string, _forceFull: boolean = false) => {
    const params = new URLSearchParams({ names: tableName });
    const res = await apiFetch<Record<string, any[]>>(`/tables?${params.toString()}`);
    return { table: tableName, data: res[tableName] || [] };
  },

  reconcileMutableTableIds: async (
    _tablesToCheck?: string[],
    _options?: { force?: boolean }
  ): Promise<Record<string, any[]>> => {
    return {};
  },

  backupTable: async (tableName: string): Promise<any[]> => {
    return apiFetch<any[]>(`/backup/${encodeURIComponent(tableName)}`);
  },

  getLedgerPaymentProof: async (id: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ bukti_bayar: string | null }>(`/ledger_entries/${encodeURIComponent(id)}/proof`);
      return data?.bukti_bayar || null;
    } catch (e) {
      console.error('Error in getLedgerPaymentProof:', e);
      return null;
    }
  },

  getExpenseProof: async (id: string): Promise<string | null> => {
    try {
      const data = await apiFetch<{ proof_image_url: string | null }>(`/expenses/${encodeURIComponent(id)}/proof`);
      return data?.proof_image_url || null;
    } catch (e) {
      console.error('Error in getExpenseProof:', e);
      return null;
    }
  },

  addMasterData: async (type: string, data: any, username: string) => {
    const endpointMap: Record<string, string> = {
      coops: '/master_coops',
      licensePlates: '/master_plates',
      customers: '/master_customers',
      items: '/master_items',
    };
    const endpoint = endpointMap[type];
    if (!endpoint) return;

    const payload =
      type === 'licensePlates'
        ? { plat: String(data).trim().toUpperCase(), username }
        : type === 'items'
        ? { name: String(data.name).trim().toUpperCase(), username }
        : { name: String(data.name).trim().toUpperCase(), address: String(data.address || '').trim(), username };

    await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  deleteMasterData: async (type: string, identifier: string, username: string) => {
    const endpointMap: Record<string, string> = {
      coops: '/master_coops',
      licensePlates: '/master_plates',
      customers: '/master_customers',
      items: '/master_items',
    };
    const endpoint = endpointMap[type];
    if (!endpoint) return;

    const params = new URLSearchParams({ username });
    await apiFetch(`${endpoint}/${encodeURIComponent(identifier)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  updateCustomerName: async (oldName: string, newName: string, newAddress: string, username: string) => {
    await apiFetch(`/master_customers/${encodeURIComponent(oldName.trim().toUpperCase())}`, {
      method: 'PUT',
      body: JSON.stringify({
        newName: newName.trim().toUpperCase(),
        newAddress: newAddress.trim(),
        username,
      }),
    });
  },

  adjustStock: async (
    itemName: string,
    change: number,
    type: string,
    notes: string,
    username?: string,
    skipLog: boolean = false,
    customDate?: string
  ) => {
    await apiFetch('/current_stock/adjust', {
      method: 'POST',
      body: JSON.stringify({ itemName, change, type, notes, username, skipLog, customDate }),
    });
  },

  syncStockOpnameBatch: async (
    items: { itemName: string; targetQty: number }[],
    date: string,
    isToday: boolean,
    username: string
  ) => {
    return apiFetch<{ updatedCount: number; skipCount: number; errorCount: number; errors: string[] }>(
      '/stock_opname',
      {
        method: 'POST',
        body: JSON.stringify({ items, date, isToday, username }),
      }
    );
  },

  addProductionLogs: async (logs: any[], autoApply: boolean, username: string) => {
    await apiFetch('/production_logs', {
      method: 'POST',
      body: JSON.stringify({ logs, autoApply, username }),
    });
  },

  applyProductionBatch: async (date: string, truckNumber: string, username: string) => {
    await apiFetch('/production_logs/apply', {
      method: 'PUT',
      body: JSON.stringify({ date, truckNumber, username }),
    });
  },

  deleteProductionBatch: async (date: string, truckNumber: string, username: string) => {
    const params = new URLSearchParams({ date, truckNumber, username });
    await apiFetch(`/production_logs/batch?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  updateProductionPrices: async (updates: { recordId: string; pricePerKg: number }[], username: string) => {
    if (!updates || updates.length === 0) return;
    await apiFetch('/production_logs/prices', {
      method: 'PUT',
      body: JSON.stringify({ updates, username }),
    });
  },

  addDeliveryOrders: async (items: any[], username: string) => {
    await apiFetch('/delivery_orders', {
      method: 'POST',
      body: JSON.stringify({ items, username }),
    });
  },

  updateDeliveryOrderWithStock: async (o: DeliveryOrder, username: string) => {
    const params = new URLSearchParams({ nomor_sj: o.id });
    await apiFetch(`/delivery_orders?${params.toString()}`, {
      method: 'PUT',
      body: JSON.stringify({ order: o, mode: 'detail', username }),
    });
  },

  syncDeliveryOrderFromInvoice: async (sjID: string, updatedOrder: DeliveryOrder, username: string) => {
    const params = new URLSearchParams({ nomor_sj: sjID });
    await apiFetch(`/delivery_orders?${params.toString()}`, {
      method: 'PUT',
      body: JSON.stringify({ order: updatedOrder, mode: 'invoice_sync', username }),
    });
  },

  deleteDeliveryOrder: async (sjNumber: string, username: string) => {
    const params = new URLSearchParams({ nomor_sj: sjNumber, username });
    await apiFetch(`/delivery_orders?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  addInvoices: async (entries: any[], username: string) => {
    await apiFetch('/invoices', {
      method: 'POST',
      body: JSON.stringify({ entries, username }),
    });
  },

  updateInvoice: async (invoiceId: string, entries: any[], username: string) => {
    const params = new URLSearchParams({ nomor_invoice: invoiceId });
    await apiFetch(`/invoices?${params.toString()}`, {
      method: 'PUT',
      body: JSON.stringify({ invoiceId, entries, username }),
    });
  },

  deleteInvoice: async (id: string, username: string) => {
    const params = new URLSearchParams({ nomor_invoice: id, username });
    await apiFetch(`/invoices?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  addLedgerEntry: async (entry: any, username: string) => {
    await apiFetch('/ledger_entries', {
      method: 'POST',
      body: JSON.stringify({ entry, username }),
    });
  },

  deleteLedgerEntry: async (id: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/ledger_entries/${encodeURIComponent(id)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  addExpense: async (data: any, username: string) => {
    const entry = {
      tanggal: data.date instanceof Date ? data.date.toISOString().slice(0, 10) : data.date,
      kategori: data.category,
      jumlah: data.amount,
      description: data.description,
      proof_image_url: data.proofImage,
    };
    await apiFetch('/expenses', {
      method: 'POST',
      body: JSON.stringify({ entries: [entry], username }),
    });
  },

  addExpenses: async (batch: any[], username: string) => {
    const entries = batch.map((data) => ({
      tanggal: data.date instanceof Date ? data.date.toISOString().slice(0, 10) : data.date,
      kategori: data.category,
      jumlah: data.amount,
      description: data.description,
      proof_image_url: data.proofImage,
    }));
    await apiFetch('/expenses', {
      method: 'POST',
      body: JSON.stringify({ entries, username }),
    });
  },

  addSalaries: async (batch: any[], username: string) => {
    const entries = batch.map((s) => ({
      tanggal: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : s.date,
      nama_karyawan: s.employeeName,
      gaji_harian: s.dailyRate,
      hari_kerja: s.daysWorked,
      kasbon: s.cashBon,
      total_gaji: s.totalSalary,
      catatan: s.notes,
    }));
    await apiFetch('/salaries', {
      method: 'POST',
      body: JSON.stringify({ entries, username }),
    });
  },

  deleteExpense: async (id: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/expenses/${encodeURIComponent(id)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  deleteSalary: async (id: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/salaries/${encodeURIComponent(id)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  addTradingPurchase: async (data: any, username: string) => {
    await apiFetch('/trading_purchases', {
      method: 'POST',
      body: JSON.stringify({ data, username }),
    });
  },

  editTradingPurchase: async (id: string, data: any, username: string) => {
    await apiFetch(`/trading_purchases/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ data, username }),
    });
  },

  deleteTradingPurchase: async (id: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/trading_purchases/${encodeURIComponent(id)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  addStockDisposal: async (data: any, username: string) => {
    await apiFetch('/stock_disposals', {
      method: 'POST',
      body: JSON.stringify({ data, username }),
    });
  },

  editStockDisposal: async (id: string, data: any, username: string) => {
    await apiFetch(`/stock_disposals/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ data, username }),
    });
  },

  deleteStockDisposal: async (id: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/stock_disposals/${encodeURIComponent(id)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  upsertEarlyStock: async (tanggal: string, amount: number, username: string) => {
    await apiFetch('/early_stock', {
      method: 'POST',
      body: JSON.stringify({ tanggal, amount, username }),
    });
  },

  deleteEarlyStock: async (tanggal: string, username: string) => {
    const params = new URLSearchParams({ username });
    await apiFetch(`/early_stock/${encodeURIComponent(tanggal)}?${params.toString()}`, {
      method: 'DELETE',
    });
  },

  executeCutoff: async (
    cutoffDateStr: string,
    cutoffDebts: Record<string, number>,
    cutoffStocks: Record<string, number>,
    username: string
  ) => {
    await apiFetch('/system/cutoff', {
      method: 'POST',
      body: JSON.stringify({ cutoffDateStr, cutoffDebts, cutoffStocks, username }),
    });
  },
};

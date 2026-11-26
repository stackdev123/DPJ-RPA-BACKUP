import { createClient } from '@supabase/supabase-js';
import { idbCache, CACHED_LARGE_TABLES, type CachedTableName } from './idbCache';
import type { DeliveryOrder } from './types';

const getSafeEnv = (key: string): string => {
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      return process.env[key] || '';
    }
    if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
      return (import.meta as any).env[key] || '';
    }
  } catch (e) { }
  return '';
};

const supabaseUrl = getSafeEnv('VITE_SUPABASE_URL') || 'https://vqmfbnqjrdyijnpaywug.supabase.co';
const supabaseAnonKey = getSafeEnv('VITE_SUPABASE_ANON_KEY') || 'sb_publishable_-MgxWwIiJHBhq1594eIdrw_NUSZKpQc';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const formatError = (error: any): string => {
  if (!error) return 'Terjadi kesalahan yang tidak diketahui';
  return error.message || JSON.stringify(error);
};

const itemLocks = new Map<string, Promise<any>>();

// Local mutation cooldown guard so self-triggered realtime events don't cause redundant double fetches
const localMutationTimestamps = new Map<string, number>();

export const markLocalMutation = (table: string, ttlMs: number = 7000) => {
  localMutationTimestamps.set(table, Date.now() + ttlMs);
};

export const isRecentlyMutatedLocally = (table: string): boolean => {
  const expiresAt = localMutationTimestamps.get(table);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    localMutationTimestamps.delete(table);
    return false;
  }
  return true;
};

export const TABLE_COLUMNS: Record<string, string> = {
  master_coops: 'name, address',
  master_customers: 'name, address',
  master_items: 'name',
  master_plates: 'plat',
  current_stock: 'item_name, quantity',
  delivery_orders: 'id, nomor_sj, tanggal, customer, nama_item, qty_kirim, qty_diterima, retur, timestamp',
  invoices: 'id, nomor_invoice, tanggal, timestamp, nomor_sj, customer, item_name, total, qty_diterima, harga, transfer, cash, keterangan, invoice_status',
  expenses: 'id, tanggal, kategori, jumlah, description',
  salaries: 'id, tanggal, nama_karyawan, gaji_harian, hari_kerja, kasbon, total_gaji, catatan',
  ledger_entries: 'id, tanggal, timestamp, debit, credit, balance, customer_id, metode_bayar, keterangan',
  stock_logs: 'id, timestamp, tipe, item_name, stok_awal, perubahan, stok_akhir, keterangan',
  production_logs: 'id, tanggal_produksi, mobil, nama_kandang, driver, ekor, kg, harga_beli_kg, kematian_ekor, kematian_kg, is_applied, plat, item_name, qty, timestamp',
  trading_purchases: 'id, tanggal, timestamp, item_name, kg, harga_per_kg',
  stock_disposals: 'id, tanggal, timestamp, item_name, kg, harga_valuasi_kg, keterangan',
  early_stock: 'tanggal, item_name, ending_stock',
};

const sleepMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const runWithRetry = async (
  queryBuilderFactory: () => PromiseLike<{ data: any; error: any; count?: number | null }>,
  label: string,
  attempts: number = 3
) => {
  let lastError: any = null;
  for (let i = 0; i < attempts; i++) {
    const { data, error, count } = await queryBuilderFactory();
    if (!error) return { data, count };
    lastError = error;
    console.warn(`Percobaan ke-${i + 1} gagal mengambil data "${label}":`, error.message || error);
    if (i < attempts - 1) await sleepMs(500 * (i + 1));
  }
  throw new Error(`Gagal mengambil data "${label}" setelah ${attempts} percobaan: ${formatError(lastError)}`);
};

// Keyset/Cursor pagination by primary key 'id' (avoids slow OFFSET at high page counts and row shifting)
const fetchAllKeyset = async (
  table: string,
  columns: string,
  filterFn?: (q: any) => any
): Promise<any[]> => {
  const step = 1000;
  const allRows: any[] = [];
  let lastId: string | null = null;

  while (true) {
    const { data } = await runWithRetry(() => {
      let q = supabase
        .from(table)
        .select(columns)
        .order('id', { ascending: true })
        .limit(step);
      if (lastId !== null) {
        q = q.gt('id', lastId);
      }
      if (filterFn) {
        q = filterFn(q);
      }
      return q;
    }, `${table} (keyset>${lastId || 'start'})`);

    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < step) break;

    const nextId = data[data.length - 1]?.id;
    if (!nextId || nextId === lastId) break;
    lastId = nextId;
  }

  return allRows;
};

const getMaxTimestamp = (rows: any[], fallbackIso: string): string => {
  let maxMs = fallbackIso ? Date.parse(fallbackIso) : 0;
  if (isNaN(maxMs)) maxMs = 0;
  for (const r of rows) {
    if (r?.timestamp) {
      const ms = Date.parse(r.timestamp);
      if (!isNaN(ms) && ms > maxMs) maxMs = ms;
    }
  }
  return maxMs > 0 ? new Date(maxMs).toISOString() : fallbackIso;
};

const applyBatchStockAdjustments = async (
  adjustments: { itemName: string; change: number; type: string; notes: string; customDate?: string }[],
  username?: string,
  skipActivityLog: boolean = false
) => {
  const validAdjustments = adjustments.filter(a => a.itemName && Math.abs(a.change) >= 0.000001);
  if (validAdjustments.length === 0) return;

  markLocalMutation('current_stock');
  markLocalMutation('stock_logs');

  const { data: currentRows, error: fetchError } = await supabase
    .from('current_stock')
    .select('item_name, quantity');

  if (fetchError) throw new Error(formatError(fetchError));

  const stockLookup = new Map<string, { actualName: string; qty: number; exists: boolean }>();
  for (const row of currentRows || []) {
    const norm = row.item_name.trim().toUpperCase();
    stockLookup.set(norm, {
      actualName: row.item_name,
      qty: Number(row.quantity) || 0,
      exists: true,
    });
  }

  const stockLogsToInsert: any[] = [];
  const itemsToUpdate = new Set<string>();

  for (const adj of validAdjustments) {
    const norm = adj.itemName.trim().toUpperCase();
    let entry = stockLookup.get(norm);
    if (!entry) {
      entry = { actualName: adj.itemName.trim(), qty: 0, exists: false };
      stockLookup.set(norm, entry);
    }

    const initialStock = entry.qty;
    const finalStock = initialStock + adj.change;
    entry.qty = finalStock;
    itemsToUpdate.add(norm);

    let logTimestamp = new Date().toISOString();
    if (adj.customDate) {
      const d = new Date(adj.customDate);
      d.setHours(23, 59, 59, 999);
      logTimestamp = d.toISOString();
    }

    stockLogsToInsert.push({
      item_name: entry.actualName,
      tipe: adj.type,
      stok_awal: initialStock,
      perubahan: adj.change,
      stok_akhir: finalStock,
      keterangan: adj.notes,
      timestamp: logTimestamp,
    });
  }

  const nowIso = new Date().toISOString();
  const stockWritePromises = Array.from(itemsToUpdate).map(async (norm) => {
    const entry = stockLookup.get(norm)!;
    if (entry.exists) {
      const { error } = await supabase
        .from('current_stock')
        .update({ quantity: entry.qty, updated_at: nowIso })
        .eq('item_name', entry.actualName);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('current_stock')
        .insert({ item_name: entry.actualName, quantity: entry.qty });
      if (error) throw error;
    }
  });

  await Promise.all([
    ...stockWritePromises,
    supabase.from('stock_logs').insert(stockLogsToInsert).then(({ error }) => {
      if (error) throw error;
    }),
  ]);

  if (username && !skipActivityLog) {
    await db.addActivityLog(username, 'UPDATE', 'current_stock', 'batch', {
      count: validAdjustments.length,
    });
  }
};

const ACTIVITY_LOG_SYNC_META_KEY = '__activity_log_sync__';
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const getReconcileMetaKey = (tableName: string) => `__full_reconcile_${tableName}__`;

let inFlightActivityReconcilePromise: Promise<boolean> | null = null;
let inFlightFullReconcilePromise: Promise<Partial<Record<CachedTableName, any[]>>> | null = null;

// Reconcile deletions/updates recorded in activity_logs since lastActivityLogSync so IndexedDB never retains stale rows
const reconcileFromActivityLogs = async (fallbackSinceIso?: string): Promise<boolean> => {
  if (typeof indexedDB === 'undefined') return false;
  if (inFlightActivityReconcilePromise) return inFlightActivityReconcilePromise;

  inFlightActivityReconcilePromise = (async () => {
    try {
      const meta = await idbCache.getMeta(ACTIVITY_LOG_SYNC_META_KEY);
      let cursorIso = meta?.lastSyncTime || fallbackSinceIso || '';

      if (!cursorIso) {
        const { data: latest } = await supabase
          .from('activity_logs')
          .select('timestamp')
          .in('action', ['DELETE', 'UPDATE', 'CUTOFF', 'UPDATE_CUSTOMER_NAME'])
          .order('timestamp', { ascending: false })
          .limit(1);
        const seedTs = latest?.[0]?.timestamp || new Date().toISOString();
        await idbCache.setMeta({ tableName: ACTIVITY_LOG_SYNC_META_KEY, lastSyncTime: seedTs, rowCount: 0 });
        return false;
      }

      const allLogs: any[] = [];
      let pageCursor = cursorIso;
      for (let page = 0; page < 5; page++) {
        const { data: logs, error } = await supabase
          .from('activity_logs')
          .select('action, target_table, target_id, details, timestamp')
          .gt('timestamp', pageCursor)
          .in('action', ['DELETE', 'UPDATE', 'CUTOFF', 'UPDATE_CUSTOMER_NAME'])
          .order('timestamp', { ascending: true })
          .limit(1000);

        if (error) return false;
        if (!logs || logs.length === 0) break;

        allLogs.push(...logs);
        pageCursor = getMaxTimestamp(logs, pageCursor);
        if (logs.length < 1000) break;
      }

      if (allLogs.length === 0) {
        return false;
      }

      const maxProcessedTs = getMaxTimestamp(allLogs, cursorIso);

      if (allLogs.some((l: any) => l.action === 'CUTOFF' || l.action === 'UPDATE_CUSTOMER_NAME')) {
        await idbCache.clearAll();
        await idbCache.setMeta({ tableName: ACTIVITY_LOG_SYNC_META_KEY, lastSyncTime: maxProcessedTs, rowCount: 0 });
        return true;
      }

      const sjToRemoveOrRefresh = new Set<string>();
      const invToRemoveOrRefresh = new Set<string>();
      const ledgerIdsToDelete = new Set<string>();
      const prodBatchesToCheck = new Set<string>();

      for (const log of allLogs) {
        if (log.target_table === 'delivery_orders' && log.target_id) {
          sjToRemoveOrRefresh.add(log.target_id);
          if (log.action === 'DELETE') {
            const cachedInvs = await idbCache.getAllRows('invoices');
            const matchingIds = cachedInvs
              .filter((r: any) => r.nomor_sj === log.target_id)
              .map((r: any) => r.id);
            await idbCache.deleteRowsByIds('invoices', matchingIds);
          }
        } else if (log.target_table === 'invoices' && log.target_id) {
          invToRemoveOrRefresh.add(log.target_id);
        } else if (log.target_table === 'ledger_entries' && log.action === 'DELETE' && log.target_id) {
          ledgerIdsToDelete.add(log.target_id);
        } else if (log.target_table === 'production_logs') {
          if (log.details?.date) {
            prodBatchesToCheck.add(log.details.date);
          } else if (Array.isArray(log.details?.dates)) {
            log.details.dates.forEach((d: string) => prodBatchesToCheck.add(d));
          }
        }
      }

      if (sjToRemoveOrRefresh.size > 0) {
        const cachedDos = await idbCache.getAllRows('delivery_orders');
        const staleDoIds = cachedDos
          .filter((r: any) => sjToRemoveOrRefresh.has(r.nomor_sj))
          .map((r: any) => r.id);
        await idbCache.deleteRowsByIds('delivery_orders', staleDoIds);

        const { data: freshDos, error: sjErr } = await supabase
          .from('delivery_orders')
          .select(TABLE_COLUMNS.delivery_orders)
          .in('nomor_sj', Array.from(sjToRemoveOrRefresh));
        if (sjErr) return false;
        if (freshDos && freshDos.length > 0) {
          await idbCache.upsertRows('delivery_orders', freshDos);
        }
      }

      if (invToRemoveOrRefresh.size > 0) {
        const cachedInvs = await idbCache.getAllRows('invoices');
        const staleInvIds = cachedInvs
          .filter((r: any) => invToRemoveOrRefresh.has(r.nomor_invoice))
          .map((r: any) => r.id);
        await idbCache.deleteRowsByIds('invoices', staleInvIds);

        const { data: freshInvs, error: invErr } = await supabase
          .from('invoices')
          .select(TABLE_COLUMNS.invoices)
          .in('nomor_invoice', Array.from(invToRemoveOrRefresh));
        if (invErr) return false;
        if (freshInvs && freshInvs.length > 0) {
          await idbCache.upsertRows('invoices', freshInvs);
        }
      }

      if (ledgerIdsToDelete.size > 0) {
        await idbCache.deleteRowsByIds('ledger_entries', Array.from(ledgerIdsToDelete));
      }

      if (prodBatchesToCheck.size > 0) {
        const datesArr = Array.from(prodBatchesToCheck);
        const cachedProds = await idbCache.getAllRows('production_logs');
        const staleProdIds = cachedProds
          .filter((r: any) => datesArr.includes(r.tanggal_produksi))
          .map((r: any) => r.id);
        await idbCache.deleteRowsByIds('production_logs', staleProdIds);

        const { data: freshProds, error: prodErr } = await supabase
          .from('production_logs')
          .select(TABLE_COLUMNS.production_logs)
          .in('tanggal_produksi', datesArr);
        if (prodErr) return false;
        if (freshProds && freshProds.length > 0) {
          await idbCache.upsertRows('production_logs', freshProds);
        }
      }

      // Advance activity_logs cursor strictly past the processed logs so they are never re-fetched
      await idbCache.setMeta({ tableName: ACTIVITY_LOG_SYNC_META_KEY, lastSyncTime: maxProcessedTs, rowCount: 0 });
      return false;
    } catch (err) {
      console.warn('Activity log reconciliation skipped:', err);
      return false;
    } finally {
      inFlightActivityReconcilePromise = null;
    }
  })();

  return inFlightActivityReconcilePromise;
};

const syncCachedTable = async (tableName: CachedTableName, forceFull: boolean = false): Promise<any[]> => {
  const columns = TABLE_COLUMNS[tableName];
  const canUseIdb = typeof indexedDB !== 'undefined';

  if (!canUseIdb || forceFull) {
    const rows = await fetchAllKeyset(tableName, columns);
    if (canUseIdb) {
      const maxTs = getMaxTimestamp(rows, '1970-01-01T00:00:00.000Z');
      await idbCache.replaceTableRows(tableName, rows, maxTs);
      await idbCache.setMeta({
        tableName: getReconcileMetaKey(tableName),
        lastSyncTime: new Date().toISOString(),
        rowCount: rows.length,
      });
    }
    return rows;
  }

  const meta = await idbCache.getMeta(tableName);
  if (!meta || !meta.lastSyncTime) {
    const rows = await fetchAllKeyset(tableName, columns);
    const maxTs = getMaxTimestamp(rows, '1970-01-01T00:00:00.000Z');
    await idbCache.replaceTableRows(tableName, rows, maxTs);
    await idbCache.setMeta({
      tableName: getReconcileMetaKey(tableName),
      lastSyncTime: new Date().toISOString(),
      rowCount: rows.length,
    });
    const actMeta = await idbCache.getMeta(ACTIVITY_LOG_SYNC_META_KEY);
    if (!actMeta?.lastSyncTime) {
      const { data: latestAct } = await supabase
        .from('activity_logs')
        .select('timestamp')
        .in('action', ['DELETE', 'UPDATE', 'CUTOFF', 'UPDATE_CUSTOMER_NAME'])
        .order('timestamp', { ascending: false })
        .limit(1);
      await idbCache.setMeta({
        tableName: ACTIVITY_LOG_SYNC_META_KEY,
        lastSyncTime: latestAct?.[0]?.timestamp || maxTs,
        rowCount: 0,
      });
    }
    return rows;
  }

  const cachedRows = await idbCache.getAllRows(tableName);
  if (cachedRows.length === 0 && meta.rowCount > 0) {
    const rows = await fetchAllKeyset(tableName, columns);
    const maxTs = getMaxTimestamp(rows, '1970-01-01T00:00:00.000Z');
    await idbCache.replaceTableRows(tableName, rows, maxTs);
    await idbCache.setMeta({
      tableName: getReconcileMetaKey(tableName),
      lastSyncTime: new Date().toISOString(),
      rowCount: rows.length,
    });
    return rows;
  }

  // Strict gt(lastSyncTime) avoids repeatedly pulling historical rows around the old cursor
  const deltaRows = await fetchAllKeyset(tableName, columns, (q) => q.gt('timestamp', meta.lastSyncTime));

  if (deltaRows.length === 0) {
    return cachedRows;
  }

  const rowMap = new Map<string, any>();
  for (const r of cachedRows) {
    if (r?.id) rowMap.set(r.id, r);
  }
  for (const r of deltaRows) {
    if (r?.id) rowMap.set(r.id, r);
  }

  const nextSyncTime = getMaxTimestamp(deltaRows, meta.lastSyncTime);
  await idbCache.upsertRows(tableName, deltaRows, nextSyncTime);
  return Array.from(rowMap.values());
};

export const db = {
  verifyUser: async (user: string, pass: string) => {
    const { data, error } = await supabase
      .rpc('verify_user', { p_user: user, p_password: pass });

    if (error) throw new Error(formatError(error));
    return (Array.isArray(data) ? data[0] : data) || null;
  },

  addActivityLog: async (username: string, action: string, targetTable: string, targetId?: string, details?: any) => {
    try {
      const payload: any = {
        username,
        action,
        target_table: targetTable,
        target_id: targetId || null,
        details: details || null
      };

      const { error } = await supabase.from('activity_logs').insert(payload);

      if (error) {
        if (error.code === '401' || error.message?.includes('401') || error.message?.includes('JWT')) {
          console.error('SUPABASE 401 UNAUTHORIZED ERROR: Kunci API (Anon Key) Anda mungkin salah, kedaluwarsa, atau RLS (Row Level Security) di tabel activity_logs masih aktif dan memblokir akses.');
        } else {
          console.error('Supabase insert error:', error);
        }
      }
    } catch (e) {
      console.error('Error adding activity log:', e);
    }
  },

  getInitialData: async (forceFull: boolean = false) => {
    if (typeof indexedDB !== 'undefined' && !forceFull) {
      const metas = await Promise.all(CACHED_LARGE_TABLES.map((t) => idbCache.getMeta(t)));
      const validSyncs = metas
        .filter((m): m is NonNullable<typeof m> => !!m && !!m.lastSyncTime && m.lastSyncTime !== '1970-01-01T00:00:00.000Z')
        .map((m) => Date.parse(m.lastSyncTime))
        .filter((ms) => !isNaN(ms));

      if (validSyncs.length > 0) {
        const minSyncIso = new Date(Math.min(...validSyncs)).toISOString();
        await reconcileFromActivityLogs(minSyncIso);
      }
    }

    // Fetch all master & transactional tables in parallel (no activity_logs, no expenses.proof_image_url)
    const [
      coops,
      customers,
      items,
      plates,
      stock,
      do_res,
      inv_res,
      exp_res,
      sal_res,
      ledger_res,
      stocklogs_res,
      prod_res,
      trad_res,
      disp_res,
      early_res,
    ] = await Promise.all([
      runWithRetry(() => supabase.from('master_coops').select(TABLE_COLUMNS.master_coops).limit(100000), 'master_coops'),
      runWithRetry(() => supabase.from('master_customers').select(TABLE_COLUMNS.master_customers).limit(100000), 'master_customers'),
      runWithRetry(() => supabase.from('master_items').select(TABLE_COLUMNS.master_items).limit(100000), 'master_items'),
      runWithRetry(() => supabase.from('master_plates').select(TABLE_COLUMNS.master_plates).limit(100000), 'master_plates'),
      runWithRetry(() => supabase.from('current_stock').select(TABLE_COLUMNS.current_stock).limit(100000), 'current_stock'),
      syncCachedTable('delivery_orders', forceFull),
      syncCachedTable('invoices', forceFull),
      fetchAllKeyset('expenses', TABLE_COLUMNS.expenses),
      fetchAllKeyset('salaries', TABLE_COLUMNS.salaries),
      syncCachedTable('ledger_entries', forceFull),
      syncCachedTable('stock_logs', forceFull),
      syncCachedTable('production_logs', forceFull),
      fetchAllKeyset('trading_purchases', TABLE_COLUMNS.trading_purchases),
      fetchAllKeyset('stock_disposals', TABLE_COLUMNS.stock_disposals),
      runWithRetry(() => supabase.from('early_stock').select(TABLE_COLUMNS.early_stock).order('tanggal', { ascending: false }).limit(10000), 'early_stock'),
    ]);

    return {
      coops: coops.data || [],
      customers: customers.data || [],
      masterItems: items.data || [],
      plates: (plates.data || []).map((p: any) => p.plat),
      currentStock: stock.data || [],
      deliveryOrders: do_res || [],
      invoices: inv_res || [],
      expenses: exp_res || [],
      salaries: sal_res || [],
      ledger: ledger_res || [],
      stockLogs: stocklogs_res || [],
      productionLogs: prod_res || [],
      tradingPurchases: trad_res || [],
      stockDisposals: disp_res || [],
      earlyStock: early_res.data || [],
    };
  },

  fetchTables: async (tableNames: string[], forceFull: boolean = false): Promise<Record<string, any[]>> => {
    const uniqueTables = Array.from(new Set(tableNames)).filter(Boolean);
    if (uniqueTables.length === 0) return {};

    // Reconcile deletions/updates from activity_logs only for the cached large tables being fetched
    const requestedCachedTables = uniqueTables.filter((t): t is CachedTableName =>
      (CACHED_LARGE_TABLES as readonly string[]).includes(t)
    );

    if (typeof indexedDB !== 'undefined' && !forceFull && requestedCachedTables.length > 0) {
      const metas = await Promise.all(requestedCachedTables.map((t) => idbCache.getMeta(t)));
      const validSyncs = metas
        .filter((m): m is NonNullable<typeof m> => !!m && !!m.lastSyncTime && m.lastSyncTime !== '1970-01-01T00:00:00.000Z')
        .map((m) => Date.parse(m.lastSyncTime))
        .filter((ms) => !isNaN(ms));

      if (validSyncs.length > 0) {
        const minSyncIso = new Date(Math.min(...validSyncs)).toISOString();
        await reconcileFromActivityLogs(minSyncIso);
      }
    }

    const results = await Promise.all(
      uniqueTables.map(async (tbl) => db.refreshSingleTable(tbl, forceFull))
    );

    const out: Record<string, any[]> = {};
    for (const res of results) {
      if (res) {
        out[res.table] = res.data;
      }
    }
    return out;
  },

  refreshSingleTable: async (tableName: string, forceFull: boolean = false): Promise<{ table: string; data: any[] } | null> => {
    if ((CACHED_LARGE_TABLES as readonly string[]).includes(tableName)) {
      const data = await syncCachedTable(tableName as CachedTableName, forceFull);
      return { table: tableName, data };
    }

    switch (tableName) {
      case 'master_coops': {
        const { data } = await runWithRetry(() => supabase.from('master_coops').select(TABLE_COLUMNS.master_coops).limit(100000), 'master_coops');
        return { table: tableName, data: data || [] };
      }
      case 'master_customers': {
        const { data } = await runWithRetry(() => supabase.from('master_customers').select(TABLE_COLUMNS.master_customers).limit(100000), 'master_customers');
        return { table: tableName, data: data || [] };
      }
      case 'master_items': {
        const { data } = await runWithRetry(() => supabase.from('master_items').select(TABLE_COLUMNS.master_items).limit(100000), 'master_items');
        return { table: tableName, data: data || [] };
      }
      case 'master_plates': {
        const { data } = await runWithRetry(() => supabase.from('master_plates').select(TABLE_COLUMNS.master_plates).limit(100000), 'master_plates');
        return { table: tableName, data: (data || []).map((p: any) => p.plat) };
      }
      case 'current_stock': {
        const { data } = await runWithRetry(() => supabase.from('current_stock').select(TABLE_COLUMNS.current_stock).limit(100000), 'current_stock');
        return { table: tableName, data: data || [] };
      }
      case 'expenses': {
        const data = await fetchAllKeyset('expenses', TABLE_COLUMNS.expenses);
        return { table: tableName, data };
      }
      case 'salaries': {
        const data = await fetchAllKeyset('salaries', TABLE_COLUMNS.salaries);
        return { table: tableName, data };
      }
      case 'trading_purchases': {
        const data = await fetchAllKeyset('trading_purchases', TABLE_COLUMNS.trading_purchases);
        return { table: tableName, data };
      }
      case 'stock_disposals': {
        const data = await fetchAllKeyset('stock_disposals', TABLE_COLUMNS.stock_disposals);
        return { table: tableName, data };
      }
      case 'early_stock': {
        const { data } = await runWithRetry(() => supabase.from('early_stock').select(TABLE_COLUMNS.early_stock).order('tanggal', { ascending: false }).limit(10000), 'early_stock');
        return { table: tableName, data: data || [] };
      }
      default:
        return null;
    }
  },

  applyRealtimeEventToCache: async (
    tableName: string,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow?: any,
    oldRow?: any
  ): Promise<any[] | null> => {
    if (!(CACHED_LARGE_TABLES as readonly string[]).includes(tableName)) return null;
    const cachedTable = tableName as CachedTableName;

    if (eventType === 'DELETE' && oldRow?.id) {
      await idbCache.deleteRowsByIds(cachedTable, [oldRow.id]);
      return await idbCache.getAllRows(cachedTable);
    }

    if ((eventType === 'INSERT' || eventType === 'UPDATE') && newRow?.id) {
      const existingMeta = await idbCache.getMeta(cachedTable);
      const prevTs = existingMeta?.lastSyncTime || '';
      let nextTs: string | undefined = undefined;
      if (newRow.timestamp) {
        const rowMs = Date.parse(newRow.timestamp);
        const prevMs = prevTs ? Date.parse(prevTs) : 0;
        if (!isNaN(rowMs) && (isNaN(prevMs) || rowMs > prevMs)) {
          nextTs = newRow.timestamp;
        }
      }
      await idbCache.upsertRows(cachedTable, [newRow], nextTs);
      return await idbCache.getAllRows(cachedTable);
    }

    return null;
  },

  reconcileMutableTableIds: async (
    tablesToCheck?: CachedTableName[],
    options?: { force?: boolean }
  ): Promise<Partial<Record<CachedTableName, any[]>>> => {
    if (typeof indexedDB === 'undefined') return {};
    if (inFlightFullReconcilePromise) return inFlightFullReconcilePromise;

    inFlightFullReconcilePromise = (async () => {
      const defaultMutable: CachedTableName[] = ['invoices', 'delivery_orders', 'ledger_entries', 'production_logs'];
      const mutableTables: CachedTableName[] = (tablesToCheck && tablesToCheck.length > 0)
        ? tablesToCheck.filter((t) => defaultMutable.includes(t))
        : defaultMutable;
      const updates: Partial<Record<CachedTableName, any[]>> = {};

      for (const tableName of mutableTables) {
        try {
          if (!options?.force) {
            const reconcileMeta = await idbCache.getMeta(getReconcileMetaKey(tableName));
            const lastReconcileMs = reconcileMeta?.lastSyncTime ? Date.parse(reconcileMeta.lastSyncTime) : 0;
            if (!isNaN(lastReconcileMs) && lastReconcileMs > 0 && (Date.now() - lastReconcileMs) < RECONCILE_INTERVAL_MS) {
              continue;
            }
          }

          const [cachedRows, remoteIdsRows] = await Promise.all([
            idbCache.getAllRows(tableName),
            fetchAllKeyset(tableName, 'id'),
          ]);
          const remoteIdSet = new Set(remoteIdsRows.map((r: any) => r.id));
          const cachedIdSet = new Set(cachedRows.map((r: any) => r.id));

          const orphanedIds: string[] = [];
          for (const row of cachedRows) {
            if (row?.id && !remoteIdSet.has(row.id)) {
              orphanedIds.push(row.id);
            }
          }

          const missingIds: string[] = [];
          for (const r of remoteIdsRows) {
            if (r?.id && !cachedIdSet.has(r.id)) {
              missingIds.push(r.id);
            }
          }

          if (orphanedIds.length > 0 || missingIds.length > 0) {
            if (orphanedIds.length > 0) {
              await idbCache.deleteRowsByIds(tableName, orphanedIds);
            }
            if (missingIds.length > 0) {
              const chunks: string[][] = [];
              for (let i = 0; i < missingIds.length; i += 200) {
                chunks.push(missingIds.slice(i, i + 200));
              }
              const fetchedMissing = await Promise.all(
                chunks.map((chunk) =>
                  supabase
                    .from(tableName)
                    .select(TABLE_COLUMNS[tableName])
                    .in('id', chunk)
                    .then((res) => res.data || [])
                )
              );
              const flatMissing = fetchedMissing.flat();
              if (flatMissing.length > 0) {
                await idbCache.upsertRows(tableName, flatMissing);
              }
            }
            updates[tableName] = await idbCache.getAllRows(tableName);
          }

          await idbCache.setMeta({
            tableName: getReconcileMetaKey(tableName),
            lastSyncTime: new Date().toISOString(),
            rowCount: remoteIdsRows.length,
          });
        } catch (err) {
          console.warn(`Background ID reconciliation failed for ${tableName}:`, err);
        }
      }

      return updates;
    })();

    try {
      return await inFlightFullReconcilePromise;
    } finally {
      inFlightFullReconcilePromise = null;
    }
  },

  getLedgerPaymentProof: async (id: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase
        .from('ledger_entries')
        .select('bukti_bayar')
        .eq('id', id)
        .single();
      if (error) {
        console.error("Gagal mengambil bukti_bayar:", error);
        return null;
      }
      return data?.bukti_bayar || null;
    } catch (e) {
      console.error("Error in getLedgerPaymentProof:", e);
      return null;
    }
  },

  getExpenseProof: async (id: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('proof_image_url')
        .eq('id', id)
        .single();
      if (error) {
        console.error("Gagal mengambil proof_image_url:", error);
        return null;
      }
      return data?.proof_image_url || null;
    } catch (e) {
      console.error("Error in getExpenseProof:", e);
      return null;
    }
  },

  addMasterData: async (type: string, data: any, username: string) => {
    const tableMap: any = { coops: 'master_coops', licensePlates: 'master_plates', customers: 'master_customers', items: 'master_items' };
    const table = tableMap[type];
    if (!table) return;

    markLocalMutation(table);
    let payload: any = {};
    if (type === 'licensePlates') {
      payload = { plat: data.trim().toUpperCase() };
    } else if (type === 'items') {
      payload = { name: data.name.trim().toUpperCase() };
    } else {
      payload = { name: data.name.trim().toUpperCase(), address: (data.address || '').trim() };
    }

    const { error } = await supabase.from(table).insert(payload);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'ADD_MASTER', table, payload.name || payload.plat, payload);
  },

  deleteMasterData: async (type: string, identifier: string, username: string) => {
    const tableMap: any = { coops: 'master_coops', licensePlates: 'master_plates', customers: 'master_customers', items: 'master_items' };
    const table = tableMap[type];
    if (!table) return;

    markLocalMutation(table);
    const column = type === 'licensePlates' ? 'plat' : 'name';
    const { error } = await supabase.from(table).delete().eq(column, identifier);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE_MASTER', table, identifier, { identifier });
  },

  updateCustomerName: async (oldName: string, newName: string, newAddress: string, username: string) => {
    const cleanNewName = newName.trim().toUpperCase();
    const cleanOldName = oldName.trim().toUpperCase();

    markLocalMutation('master_customers');
    markLocalMutation('delivery_orders');
    markLocalMutation('invoices');
    markLocalMutation('ledger_entries');

    const { error: masterError } = await supabase
      .from('master_customers')
      .update({ name: cleanNewName, address: newAddress.trim() })
      .eq('name', cleanOldName);

    if (masterError) throw new Error(formatError(masterError));

    await Promise.all([
      supabase.from('delivery_orders').update({ customer: cleanNewName }).eq('customer', cleanOldName),
      supabase.from('invoices').update({ customer: cleanNewName }).eq('customer', cleanOldName),
      supabase.from('ledger_entries').update({ customer_id: cleanNewName }).eq('customer_id', cleanOldName),
    ]);

    // Clear affected cached tables so next sync/refresh picks up updated customer names cleanly
    await idbCache.clearAll();
    await db.addActivityLog(username, 'UPDATE_CUSTOMER_NAME', 'master_customers', cleanOldName, { oldName: cleanOldName, newName: cleanNewName });
  },

  fetchActivityLogs: async (startDate?: string, endDate?: string, action?: string) => {
    let query = supabase.from('activity_logs').select('*').order('timestamp', { ascending: false }).limit(1000);
    if (startDate) query = query.gte('timestamp', startDate + 'T00:00:00Z');
    if (endDate) query = query.lte('timestamp', endDate + 'T23:59:59Z');
    if (action && action !== 'ALL') query = query.eq('action', action);

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching activity logs:', error);
      return [];
    }
    return data || [];
  },

  adjustStock: async (itemName: string, change: number, type: string, notes: string, username?: string, skipLog: boolean = false, customDate?: string) => {
    const normName = itemName.trim().toUpperCase();
    const existingLock = itemLocks.get(normName) || Promise.resolve();

    const currentAdjustment = (async () => {
      try {
        await existingLock;
        markLocalMutation('current_stock');
        markLocalMutation('stock_logs');

        let effectiveItemName = itemName.trim();

        const { data: matches, error: fetchError } = await supabase
          .from('current_stock')
          .select('quantity, item_name')
          .ilike('item_name', effectiveItemName);

        if (fetchError) throw fetchError;

        let currentItem = (matches || []).find(s => s.item_name.trim().toUpperCase() === normName);
        if (currentItem) {
          effectiveItemName = currentItem.item_name;
        }

        const initialStock = currentItem ? Number(currentItem.quantity) : 0;
        const finalStock = initialStock + change;

        if (currentItem) {
          const { error: updateError } = await supabase
            .from('current_stock')
            .update({ quantity: finalStock, updated_at: new Date().toISOString() })
            .eq('item_name', effectiveItemName);
          if (updateError) throw updateError;
        } else {
          const { error: insertError } = await supabase
            .from('current_stock')
            .insert({ item_name: effectiveItemName, quantity: finalStock });
          if (insertError) throw insertError;
        }

        let logTimestamp = new Date().toISOString();
        if (customDate) {
          const d = new Date(customDate);
          d.setHours(23, 59, 59, 999);
          logTimestamp = d.toISOString();
        }

        const { error: logError } = await supabase.from('stock_logs').insert({
          item_name: effectiveItemName,
          tipe: type,
          stok_awal: initialStock,
          perubahan: change,
          stok_akhir: finalStock,
          keterangan: notes,
          timestamp: logTimestamp
        });
        if (logError) throw logError;

        if (username && !skipLog && type !== 'Produksi') {
          await db.addActivityLog(username, 'UPDATE', 'current_stock', effectiveItemName, { change, type, notes, customDate });
        }
      } catch (err) {
        console.error(`[db.adjustStock] FAILED for ${itemName}:`, err);
        throw err;
      }
    })();

    itemLocks.set(normName, currentAdjustment);
    return currentAdjustment;
  },

  syncStockOpnameBatch: async (
    items: { itemName: string; targetQty: number }[],
    date: string,
    isToday: boolean,
    username: string
  ) => {
    markLocalMutation('current_stock');
    markLocalMutation('stock_logs');

    const validEntries = items.filter((it) => !isNaN(it.targetQty));
    const skipInvalidCount = items.length - validEntries.length;

    const { data: allCurrentStock, error: stockErr } = await supabase
      .from('current_stock')
      .select('item_name, quantity');
    if (stockErr) throw new Error(formatError(stockErr));

    const stockMap = new Map<string, { actualName: string; qty: number; exists: boolean }>();
    for (const row of allCurrentStock || []) {
      stockMap.set(row.item_name.trim().toUpperCase(), {
        actualName: row.item_name,
        qty: Number(row.quantity) || 0,
        exists: true,
      });
    }

    let filterDateIso = '';
    if (!isToday) {
      const filterDate = new Date(date);
      filterDate.setHours(23, 59, 59, 999);
      filterDateIso = filterDate.toISOString();
    }

    // Resolve reference stock per item in parallel (1 round-trip instead of 23 sequential loops)
    const refResults = await Promise.all(
      validEntries.map(async ({ itemName, targetQty }) => {
        const normName = itemName.trim().toUpperCase();
        const existing = stockMap.get(normName);
        const effectiveItemName = existing ? existing.actualName : itemName.trim();
        const liveStockNow = existing ? existing.qty : 0;

        let systemQtyAtRefPoint = liveStockNow;
        if (!isToday) {
          const { data: logs } = await supabase
            .from('stock_logs')
            .select('stok_akhir')
            .ilike('item_name', effectiveItemName)
            .lte('timestamp', filterDateIso)
            .order('timestamp', { ascending: false })
            .limit(1);

          if (logs && logs.length > 0) {
            systemQtyAtRefPoint = Number(logs[0].stok_akhir);
          } else {
            const { data: futureLogs } = await supabase
              .from('stock_logs')
              .select('stok_awal')
              .ilike('item_name', effectiveItemName)
              .gt('timestamp', filterDateIso)
              .order('timestamp', { ascending: true })
              .limit(1);

            if (futureLogs && futureLogs.length > 0) {
              systemQtyAtRefPoint = Number(futureLogs[0].stok_awal);
            }
          }
        }

        const variance = targetQty - systemQtyAtRefPoint;
        return {
          effectiveItemName,
          normName,
          targetQty,
          systemQtyAtRefPoint,
          variance,
          newLiveStock: liveStockNow + variance,
          exists: !!existing,
        };
      })
    );

    const changedItems = refResults.filter((r) => Math.abs(r.variance) >= 0.000001);
    const skipCount = skipInvalidCount + (refResults.length - changedItems.length);

    if (changedItems.length === 0) {
      return { updatedCount: 0, skipCount, errorCount: 0, errors: [] as string[] };
    }

    let logTimestamp = new Date().toISOString();
    if (!isToday) {
      logTimestamp = filterDateIso;
    }
    const nowIso = new Date().toISOString();

    const stockLogBatch = changedItems.map((r) => ({
      item_name: r.effectiveItemName,
      tipe: 'Opname',
      stok_awal: r.systemQtyAtRefPoint,
      perubahan: r.variance,
      stok_akhir: r.targetQty,
      keterangan: `Opname tanggal ${date}`,
      timestamp: logTimestamp,
    }));

    const errors: string[] = [];
    let updatedCount = 0;

    await Promise.all([
      ...changedItems.map(async (r) => {
        try {
          if (r.exists) {
            const { error } = await supabase
              .from('current_stock')
              .update({ quantity: r.newLiveStock, updated_at: nowIso })
              .eq('item_name', r.effectiveItemName);
            if (error) throw error;
          } else {
            const { error } = await supabase
              .from('current_stock')
              .insert({ item_name: r.effectiveItemName, quantity: r.newLiveStock });
            if (error) throw error;
          }
          updatedCount++;
        } catch (err: any) {
          errors.push(`${r.effectiveItemName}: ${err.message}`);
        }
      }),
      supabase.from('stock_logs').insert(stockLogBatch).then(({ error }) => {
        if (error) errors.push(`stock_logs batch: ${error.message}`);
      }),
    ]);

    await db.addActivityLog(username, 'SYNC_OPNAME', 'current_stock', date, {
      count: changedItems.length,
      date,
    });

    return {
      updatedCount,
      skipCount,
      errorCount: errors.length,
      errors,
    };
  },

  addProductionLogs: async (logs: any[], autoApply: boolean, username: string) => {
    markLocalMutation('production_logs');
    const { error } = await supabase.from('production_logs').insert(logs.map(l => ({ ...l, is_applied: autoApply })));
    if (error) throw new Error(formatError(error));
    if (autoApply) {
      await applyBatchStockAdjustments(
        logs.map((log) => ({
          itemName: log.item_name,
          change: Number(log.qty),
          type: 'Produksi',
          notes: `Mobil ${log.mobil} (${log.tanggal_produksi})`,
        })),
        username,
        true
      );
    }
    await db.addActivityLog(username, 'CREATE', 'production_logs', 'multiple', { count: logs.length, autoApply });
  },

  applyProductionBatch: async (date: string, truckNumber: string, username: string) => {
    markLocalMutation('production_logs');
    const { data: logs } = await supabase.from('production_logs').select('*').eq('tanggal_produksi', date).eq('mobil', truckNumber).eq('is_applied', false);
    if (!logs || logs.length === 0) return;
    await applyBatchStockAdjustments(
      logs.map((log) => ({
        itemName: log.item_name,
        change: Number(log.qty),
        type: 'Produksi',
        notes: `Apply Stok: Mobil ${truckNumber} (${date})`,
      })),
      username,
      true
    );
    await supabase.from('production_logs').update({ is_applied: true }).eq('tanggal_produksi', date).eq('mobil', truckNumber);
    await db.addActivityLog(username, 'UPDATE', 'production_logs', `${date}-${truckNumber}`, { date, truckNumber, applied: true });
  },

  deleteProductionBatch: async (date: string, truckNumber: string, username: string) => {
    markLocalMutation('production_logs');
    const { data: logs } = await supabase.from('production_logs').select('*').eq('tanggal_produksi', date).eq('mobil', truckNumber);
    if (logs && logs.length > 0) {
      const appliedLogs = logs.filter(log => log.is_applied);
      if (appliedLogs.length > 0) {
        await applyBatchStockAdjustments(
          appliedLogs.map((log) => ({
            itemName: log.item_name,
            change: -Number(log.qty),
            type: 'Produksi',
            notes: `REVERSAL: Hapus Batch Mobil ${truckNumber} (${date})`,
          })),
          username,
          true
        );
      }
      await supabase.from('production_logs').delete().eq('tanggal_produksi', date).eq('mobil', truckNumber);
      if (typeof indexedDB !== 'undefined') {
        await idbCache.deleteRowsByIds('production_logs', logs.map((l: any) => l.id).filter(Boolean));
      }
      await db.addActivityLog(username, 'DELETE', 'production_logs', `${date}-${truckNumber}`, { date, truckNumber });
    }
  },

  addDeliveryOrders: async (items: any[], username: string) => {
    markLocalMutation('delivery_orders');
    const { error } = await supabase.from('delivery_orders').insert(items);
    if (error) throw new Error(formatError(error));

    await applyBatchStockAdjustments(
      items
        .filter(item => (item.qty_kirim2 !== undefined ? Number(item.qty_kirim2) : Number(item.qty_kirim)) > 0)
        .map(item => {
          const qtyToUpdate = item.qty_kirim2 !== undefined ? Number(item.qty_kirim2) : Number(item.qty_kirim);
          return {
            itemName: item.nama_item,
            change: -qtyToUpdate,
            type: 'Alokasi',
            notes: `SJ ${item.nomor_sj} untuk ${item.customer}`,
          };
        }),
      username
    );

    await db.addActivityLog(username, 'CREATE', 'delivery_orders', items[0]?.nomor_sj, { count: items.length });
  },

  updateDeliveryOrderWithStock: async (o: DeliveryOrder, username: string) => {
    markLocalMutation('delivery_orders');
    markLocalMutation('current_stock');
    markLocalMutation('stock_logs');

    const { data: previousData, error: prevErr } = await supabase
      .from('delivery_orders')
      .select('id, nama_item, retur, qty_kirim')
      .eq('nomor_sj', o.id);
    if (prevErr) throw new Error(formatError(prevErr));

    const adjustQty = (_name: string, q: number) => q;
    const stockAdjustments: { itemName: string; change: number; type: string; notes: string }[] = [];

    if (previousData && previousData.length > 0) {
      for (const prev of previousData) {
        const kgRetur = adjustQty(prev.nama_item, Number(prev.retur || 0));
        if (kgRetur > 0) {
          stockAdjustments.push({
            itemName: prev.nama_item,
            change: -kgRetur,
            type: 'Alokasi',
            notes: `Koreksi Retur SJ ${o.id}`,
          });
        }
      }

      const processedItems = new Set<string>();
      for (const it of o.items) {
        processedItems.add(it.name);
        const prevItem = previousData.find((prev: any) => prev.nama_item === it.name);
        const qtyKirim = it.quantity;
        const prevQtyKirim = prevItem ? Number(prevItem.qty_kirim) : 0;

        if (qtyKirim !== prevQtyKirim) {
          const kgDiffKirim = adjustQty(it.name, qtyKirim - prevQtyKirim);
          if (kgDiffKirim !== 0) {
            stockAdjustments.push({
              itemName: it.name,
              change: -kgDiffKirim,
              type: 'Alokasi',
              notes: `Update kuantitas Kirim SJ ${o.id}: dari ${prevQtyKirim} menjadi ${qtyKirim}`,
            });
          }
        }

        const newRetur = o.rejectedItems?.find((ri) => ri.name === it.name)?.quantity || 0;
        const prevRetur = prevItem ? Number(prevItem.retur) : 0;
        if (newRetur !== prevRetur) {
          const kgDiffRetur = adjustQty(it.name, newRetur - prevRetur);
          if (kgDiffRetur !== 0) {
            stockAdjustments.push({
              itemName: it.name,
              change: kgDiffRetur,
              type: 'Alokasi',
              notes: `Update kuantitas Retur SJ ${o.id}: dari ${prevRetur} menjadi ${newRetur}`,
            });
          }
        }
      }

      for (const prev of previousData) {
        if (!processedItems.has(prev.nama_item)) {
          const kgNet = adjustQty(prev.nama_item, Number(prev.qty_kirim) - Number(prev.retur));
          if (kgNet > 0) {
            stockAdjustments.push({
              itemName: prev.nama_item,
              change: kgNet,
              type: 'Alokasi',
              notes: `Hapus item SJ ${o.id} (Kembali ke stok)`,
            });
          }
        }
      }
    } else if (o.rejectedItems && o.rejectedItems.length > 0) {
      for (const item of o.rejectedItems) {
        const kgRetur = adjustQty(item.name, Number(item.quantity));
        if (kgRetur > 0) {
          stockAdjustments.push({
            itemName: item.name,
            change: kgRetur,
            type: 'Alokasi',
            notes: `Retur dari SJ ${o.id}`,
          });
        }
      }
    }

    const dbEntries = o.items.map((it) => {
      const qtyKirim = it.quantity;
      const qtyDiterima = o.receivedItems?.find((ri) => ri.name === it.name)?.quantity || 0;
      return {
        tanggal: o.date.toISOString().slice(0, 10),
        nomor_sj: o.id,
        customer: o.customer,
        nama_item: it.name,
        qty_kirim: qtyKirim,
        qty_kirim2: adjustQty(it.name, qtyKirim),
        qty_diterima: qtyDiterima,
        qty_diterima2: adjustQty(it.name, qtyDiterima),
        retur: o.rejectedItems?.find((ri) => ri.name === it.name)?.quantity || 0,
      };
    });

    await applyBatchStockAdjustments(stockAdjustments, username);
    await supabase.from('delivery_orders').delete().eq('nomor_sj', o.id);
    if (previousData && previousData.length > 0 && typeof indexedDB !== 'undefined') {
      await idbCache.deleteRowsByIds('delivery_orders', previousData.map((p: any) => p.id).filter(Boolean));
    }
    const { error: insertErr } = await supabase.from('delivery_orders').insert(dbEntries);
    if (insertErr) throw new Error(formatError(insertErr));
    await db.addActivityLog(username, 'UPDATE', 'delivery_orders', o.id, { count: dbEntries.length });
  },

  syncDeliveryOrderFromInvoice: async (sjID: string, updatedOrder: DeliveryOrder, username: string) => {
    markLocalMutation('delivery_orders');
    markLocalMutation('current_stock');
    markLocalMutation('stock_logs');

    const { data: previousData } = await supabase
      .from('delivery_orders')
      .select('id, nama_item, qty_kirim')
      .eq('nomor_sj', sjID);

    const adjustQty = (_name: string, q: number) => q;
    const stockAdjustments: { itemName: string; change: number; type: string; notes: string }[] = [];

    if (previousData) {
      for (const it of updatedOrder.items) {
        const prevItem = previousData.find((prev: any) => prev.nama_item === it.name);
        const qtyKirim = it.quantity;
        const prevQtyKirim = prevItem ? Number(prevItem.qty_kirim) : 0;
        if (qtyKirim !== prevQtyKirim) {
          const kgDiff = adjustQty(it.name, qtyKirim - prevQtyKirim);
          if (kgDiff !== 0) {
            stockAdjustments.push({
              itemName: it.name,
              change: -kgDiff,
              type: 'Alokasi',
              notes: `Update kuantitas SJ ${sjID} dari Invoice: dari ${prevQtyKirim} menjadi ${qtyKirim}`,
            });
          }
        }
      }
      for (const prev of previousData) {
        const stillExists = updatedOrder.items.some((it) => it.name === prev.nama_item);
        if (!stillExists) {
          const kgQty = adjustQty(prev.nama_item, Number(prev.qty_kirim));
          if (kgQty > 0) {
            stockAdjustments.push({
              itemName: prev.nama_item,
              change: kgQty,
              type: 'Alokasi',
              notes: `Hapus item SJ ${sjID} dari Invoice`,
            });
          }
        }
      }
    }

    const doEntries = updatedOrder.items.map((it) => {
      const qtyKirim = it.quantity;
      const qtyDiterima = updatedOrder.receivedItems?.find((ri) => ri.name === it.name)?.quantity || 0;
      return {
        tanggal: updatedOrder.date.toISOString().slice(0, 10),
        nomor_sj: sjID,
        customer: updatedOrder.customer,
        nama_item: it.name,
        qty_kirim: qtyKirim,
        qty_kirim2: adjustQty(it.name, qtyKirim),
        qty_diterima: qtyDiterima,
        qty_diterima2: adjustQty(it.name, qtyDiterima),
        retur: updatedOrder.rejectedItems?.find((ri) => ri.name === it.name)?.quantity || 0,
      };
    });

    await applyBatchStockAdjustments(stockAdjustments, username);
    await supabase.from('delivery_orders').delete().eq('nomor_sj', sjID);
    if (previousData && previousData.length > 0 && typeof indexedDB !== 'undefined') {
      await idbCache.deleteRowsByIds('delivery_orders', previousData.map((p: any) => p.id).filter(Boolean));
    }
    const { error: insertErr } = await supabase.from('delivery_orders').insert(doEntries);
    if (insertErr) throw new Error(formatError(insertErr));
    await db.addActivityLog(username, 'UPDATE', 'delivery_orders', sjID, { count: doEntries.length, source: 'invoice_sync' });
  },

  deleteDeliveryOrder: async (sjNumber: string, username: string) => {
    markLocalMutation('delivery_orders');
    markLocalMutation('invoices');
    const [{ data: orders }, { data: linkedInvoices }] = await Promise.all([
      supabase.from('delivery_orders').select('*').eq('nomor_sj', sjNumber),
      supabase.from('invoices').select('id').eq('nomor_sj', sjNumber),
    ]);

    if (orders && orders.length > 0) {
      const stockAdjustments: { itemName: string; change: number; type: string; notes: string }[] = [];
      for (const order of orders) {
        if (Number(order.qty_kirim) > 0) {
          stockAdjustments.push({
            itemName: order.nama_item,
            change: Number(order.qty_kirim),
            type: 'Alokasi',
            notes: `REVERSAL: Hapus SJ ${sjNumber}`,
          });
        }
        if (Number(order.retur) > 0) {
          stockAdjustments.push({
            itemName: order.nama_item,
            change: -Number(order.retur),
            type: 'Alokasi',
            notes: `REVERSAL RETUR: Hapus SJ ${sjNumber}`,
          });
        }
      }

      await applyBatchStockAdjustments(stockAdjustments, username);
      await Promise.all([
        supabase.from('delivery_orders').delete().eq('nomor_sj', sjNumber),
        supabase.from('invoices').delete().eq('nomor_sj', sjNumber),
      ]);

      if (typeof indexedDB !== 'undefined') {
        await Promise.all([
          idbCache.deleteRowsByIds('delivery_orders', orders.map((o: any) => o.id).filter(Boolean)),
          idbCache.deleteRowsByIds('invoices', (linkedInvoices || []).map((i: any) => i.id).filter(Boolean)),
        ]);
      }

      await db.addActivityLog(username, 'DELETE', 'delivery_orders', sjNumber, `${username} Menghapus DO No ${sjNumber} customer ${orders[0].customer}`);
    }
  },

  addInvoices: async (entries: any[], username: string) => {
    markLocalMutation('invoices');
    const { error } = await supabase.from('invoices').insert(entries);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'CREATE', 'invoices', entries[0]?.nomor_invoice, { count: entries.length });
  },

  updateInvoice: async (invoiceId: string, entries: any[], username: string) => {
    markLocalMutation('invoices');
    const { data: oldRows } = await supabase.from('invoices').select('id').eq('nomor_invoice', invoiceId);
    await supabase.from('invoices').delete().eq('nomor_invoice', invoiceId);
    if (oldRows && oldRows.length > 0 && typeof indexedDB !== 'undefined') {
      await idbCache.deleteRowsByIds('invoices', oldRows.map((r: any) => r.id).filter(Boolean));
    }
    const { error } = await supabase.from('invoices').insert(entries);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'UPDATE', 'invoices', invoiceId, { count: entries.length });
  },

  deleteInvoice: async (id: string, username: string) => {
    markLocalMutation('invoices');
    const { data: oldRows } = await supabase.from('invoices').select('id').eq('nomor_invoice', id);
    const { error } = await supabase.from('invoices').delete().eq('nomor_invoice', id);
    if (error) throw new Error(formatError(error));
    if (oldRows && oldRows.length > 0 && typeof indexedDB !== 'undefined') {
      await idbCache.deleteRowsByIds('invoices', oldRows.map((r: any) => r.id).filter(Boolean));
    }
    await db.addActivityLog(username, 'DELETE', 'invoices', id);
  },

  addLedgerEntry: async (entry: any, username: string) => {
    markLocalMutation('ledger_entries');
    const { error } = await supabase.from('ledger_entries').insert(entry);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'CREATE', 'ledger_entries', entry.id, { amount: entry.credit || entry.debit });
  },

  deleteLedgerEntry: async (id: string, username: string) => {
    markLocalMutation('ledger_entries');
    const { error } = await supabase.from('ledger_entries').delete().eq('id', id);
    if (error) throw new Error(formatError(error));
    if (typeof indexedDB !== 'undefined') {
      await idbCache.deleteRowsByIds('ledger_entries', [id]);
    }
    await db.addActivityLog(username, 'DELETE', 'ledger_entries', id);
  },

  addExpense: async (data: any, username: string) => {
    markLocalMutation('expenses');
    const { error } = await supabase.from('expenses').insert({ tanggal: data.date.toISOString().slice(0, 10), kategori: data.category, jumlah: data.amount, description: data.description, proof_image_url: data.proofImage });
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'CREATE', 'expenses', 'new', { category: data.category, amount: data.amount });
  },

  addExpenses: async (batch: any[], username: string) => {
    markLocalMutation('expenses');
    const entries = batch.map(data => ({
      tanggal: data.date.toISOString().slice(0, 10),
      kategori: data.category,
      jumlah: data.amount,
      description: data.description,
      proof_image_url: data.proofImage
    }));
    const { error } = await supabase.from('expenses').insert(entries);
    if (error) throw new Error(formatError(error));
    await Promise.all(
      batch.map(data => db.addActivityLog(username, 'CREATE', 'expenses', 'batch', { category: data.category, amount: data.amount }))
    );
  },

  addSalaries: async (batch: any[], username: string) => {
    markLocalMutation('salaries');
    const entries = batch.map(s => ({ tanggal: s.date.toISOString().slice(0, 10), nama_karyawan: s.employeeName, gaji_harian: s.dailyRate, hari_kerja: s.daysWorked, kasbon: s.cashBon, total_gaji: s.totalSalary, catatan: s.notes }));
    const { error } = await supabase.from('salaries').insert(entries);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'CREATE', 'salaries', 'batch', { count: batch.length });
  },

  deleteExpense: async (id: string, username: string) => {
    markLocalMutation('expenses');
    const { error } = await supabase.from('expenses').delete().eq('id', id);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE', 'expenses', id);
  },

  deleteSalary: async (id: string, username: string) => {
    markLocalMutation('salaries');
    const { error } = await supabase.from('salaries').delete().eq('id', id);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE', 'salaries', id);
  },

  updateProductionPrices: async (updates: { recordId: string, pricePerKg: number }[], username: string) => {
    if (!updates || updates.length === 0) return;
    markLocalMutation('production_logs');

    const recordIds = updates.map(u => u.recordId).filter(Boolean);
    const { data: records, error: fetchErr } = await supabase
      .from('production_logs')
      .select('id, tanggal_produksi, mobil')
      .in('id', recordIds);

    if (fetchErr) throw new Error(formatError(fetchErr));

    const recordMap = new Map<string, { tanggal_produksi: string; mobil: string }>();
    for (const r of records || []) {
      recordMap.set(r.id, { tanggal_produksi: r.tanggal_produksi, mobil: r.mobil });
    }

    const batchUpdates = new Map<string, { date: string; mobil: string; pricePerKg: number }>();
    for (const u of updates) {
      const rec = recordMap.get(u.recordId);
      if (rec) {
        batchUpdates.set(`${rec.tanggal_produksi}::${rec.mobil}`, {
          date: rec.tanggal_produksi,
          mobil: rec.mobil,
          pricePerKg: u.pricePerKg,
        });
      }
    }

    await Promise.all(
      Array.from(batchUpdates.values()).map(async (b) => {
        const { error } = await supabase
          .from('production_logs')
          .update({ harga_beli_kg: b.pricePerKg })
          .eq('tanggal_produksi', b.date)
          .eq('mobil', b.mobil);
        if (error) throw new Error(formatError(error));
      })
    );

    const affectedDates = Array.from(new Set(Array.from(batchUpdates.values()).map(b => b.date)));
    await db.addActivityLog(username || 'system', 'UPDATE', 'production_logs', 'prices', { dates: affectedDates });
  },

  addTradingPurchase: async (data: any, username: string) => {
    markLocalMutation('trading_purchases');
    const { error } = await supabase.from('trading_purchases').insert(data);
    if (error) throw new Error(formatError(error));
    await db.adjustStock(data.item_name, Number(data.kg), 'Pembelian', `Trading Purchase (${data.tanggal})`, username);
    await db.addActivityLog(username, 'CREATE', 'trading_purchases', 'new', { item: data.item_name, kg: data.kg });
  },

  editTradingPurchase: async (id: string, data: any, username: string) => {
    markLocalMutation('trading_purchases');
    const { data: original } = await supabase.from('trading_purchases').select('*').eq('id', id).single();
    if (!original) throw new Error("Original record not found");

    await applyBatchStockAdjustments([
      { itemName: original.item_name, change: -Number(original.kg), type: 'Edit Pembelian', notes: `Reversal Edit Trading Purchase (${original.tanggal})` },
      { itemName: data.item_name, change: Number(data.kg), type: 'Edit Pembelian', notes: `Apply Edit Trading Purchase (${data.tanggal})` },
    ], username);

    const { error } = await supabase.from('trading_purchases').update(data).eq('id', id);
    if (error) throw new Error(formatError(error));

    await db.addActivityLog(username, 'UPDATE', 'trading_purchases', id, { new_data: data, old_data: original });
  },

  deleteTradingPurchase: async (id: string, username: string) => {
    markLocalMutation('trading_purchases');
    const { data: original } = await supabase.from('trading_purchases').select('*').eq('id', id).single();
    if (original) {
      await db.adjustStock(original.item_name, -Number(original.kg), 'Hapus Pembelian', `Reversal Hapus Trading Purchase (${original.tanggal})`, username);
    }
    const { error } = await supabase.from('trading_purchases').delete().eq('id', id);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE', 'trading_purchases', id);
  },

  addStockDisposal: async (data: any, username: string) => {
    markLocalMutation('stock_disposals');
    const { error } = await supabase.from('stock_disposals').insert(data);
    if (error) throw new Error(formatError(error));
    await db.adjustStock(data.item_name, -Number(data.kg), 'Pemusnahan', `Pemusnahan: ${data.keterangan}`, username, false);
    await db.addActivityLog(username, 'CREATE', 'stock_disposals', 'new', { item: data.item_name, kg: data.kg });
  },

  editStockDisposal: async (id: string, data: any, username: string) => {
    markLocalMutation('stock_disposals');
    const { data: original } = await supabase.from('stock_disposals').select('*').eq('id', id).single();
    if (!original) throw new Error("Original record not found");

    await applyBatchStockAdjustments([
      { itemName: original.item_name, change: Number(original.kg), type: 'Edit Pemusnahan', notes: `Reversal Edit Pemusnahan (${original.tanggal})` },
      { itemName: data.item_name, change: -Number(data.kg), type: 'Edit Pemusnahan', notes: `Apply Edit Pemusnahan (${data.tanggal})` },
    ], username);

    const { error } = await supabase.from('stock_disposals').update(data).eq('id', id);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'UPDATE', 'stock_disposals', id, { new_data: data, old_data: original });
  },

  deleteStockDisposal: async (id: string, username: string) => {
    markLocalMutation('stock_disposals');
    const { data: original } = await supabase.from('stock_disposals').select('*').eq('id', id).single();
    if (original) {
      await db.adjustStock(original.item_name, Number(original.kg), 'Hapus Pemusnahan', `Reversal Hapus Pemusnahan (${original.tanggal})`, username, false);
    }
    const { error } = await supabase.from('stock_disposals').delete().eq('id', id);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE', 'stock_disposals', id);
  },

  upsertEarlyStock: async (tanggal: string, amount: number, username: string) => {
    markLocalMutation('early_stock');
    await supabase
      .from('early_stock')
      .delete()
      .eq('tanggal', tanggal);

    const { error } = await supabase
      .from('early_stock')
      .insert({
        tanggal,
        item_name: 'TOTAL_SNAPSHOT',
        ending_stock: amount
      });

    if (error) throw new Error(formatError(error));

    await db.addActivityLog(username, 'UPSERT_ENDING_INVENTORY', 'early_stock', tanggal, { amount });
  },

  deleteEarlyStock: async (tanggal: string, username: string) => {
    markLocalMutation('early_stock');
    const { error } = await supabase
      .from('early_stock')
      .delete()
      .eq('tanggal', tanggal);
    if (error) throw new Error(formatError(error));
    await db.addActivityLog(username, 'DELETE_ENDING_INVENTORY', 'early_stock', tanggal);
  },

  executeCutoff: async (cutoffDateStr: string, cutoffDebts: Record<string, number>, cutoffStocks: Record<string, number>, username: string) => {
    const tablesWithTanggal = ['delivery_orders', 'invoices', 'expenses', 'salaries', 'ledger_entries', 'trading_purchases', 'stock_disposals'];
    tablesWithTanggal.forEach(t => markLocalMutation(t));
    markLocalMutation('production_logs');
    markLocalMutation('stock_logs');

    const cutoffTimestamp = cutoffDateStr + 'T00:00:00.000Z';
    await Promise.all([
      ...tablesWithTanggal.map(table => supabase.from(table).delete().lt('tanggal', cutoffDateStr)),
      supabase.from('production_logs').delete().lt('tanggal_produksi', cutoffDateStr),
      supabase.from('stock_logs').delete().lt('timestamp', cutoffTimestamp),
    ]);

    const ledgerRows = Object.entries(cutoffDebts)
      .filter(([, balance]) => balance > 0)
      .map(([customerId, balance]) => ({
        customer_id: customerId,
        tanggal: cutoffDateStr,
        keterangan: 'Saldo Awal Cutoff',
        debit: balance,
        credit: 0,
      }));
    if (ledgerRows.length > 0) {
      await supabase.from('ledger_entries').insert(ledgerRows);
    }

    const stockRows = Object.entries(cutoffStocks)
      .filter(([, qty]) => qty !== 0)
      .map(([itemName, qty]) => ({
        item_name: itemName,
        timestamp: cutoffTimestamp,
        tipe: 'CUTOFF',
        stok_awal: 0,
        perubahan: qty,
        stok_akhir: qty,
        keterangan: 'Stok Awal Cutoff',
      }));
    if (stockRows.length > 0) {
      await supabase.from('stock_logs').insert(stockRows);
    }

    await idbCache.clearAll();
    await db.addActivityLog(username, 'CUTOFF', 'system', 'all', { cutoff_date: cutoffDateStr });
  }
};
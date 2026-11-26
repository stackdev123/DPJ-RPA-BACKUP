const DB_NAME = 'dpj_rpa_cache_v1';
const DB_VERSION = 1;

export const CACHED_LARGE_TABLES = [
  'invoices',
  'delivery_orders',
  'stock_logs',
  'production_logs',
  'ledger_entries',
] as const;

export type CachedTableName = (typeof CACHED_LARGE_TABLES)[number];

interface TableMeta {
  tableName: string;
  lastSyncTime: string;
  rowCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

const openCacheDB = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of CACHED_LARGE_TABLES) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'tableName' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
};

export const idbCache = {
  async getMeta(tableName: string): Promise<TableMeta | null> {
    try {
      const db = await openCacheDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get(tableName);
        req.onsuccess = () => resolve((req.result as TableMeta) || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },

  async setMeta(meta: TableMeta): Promise<void> {
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore cache write errors safely
    }
  },

  async getAllRows<T = any>(tableName: CachedTableName): Promise<T[]> {
    try {
      const db = await openCacheDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(tableName, 'readonly');
        const req = tx.objectStore(tableName).getAll();
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  },

  async replaceTableRows(tableName: CachedTableName, rows: any[], lastSyncTime: string): Promise<void> {
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([tableName, 'meta'], 'readwrite');
        const store = tx.objectStore(tableName);
        store.clear();
        for (const row of rows) {
          if (row && row.id !== undefined && row.id !== null) {
            store.put(row);
          }
        }
        tx.objectStore('meta').put({
          tableName,
          lastSyncTime,
          rowCount: rows.length,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore cache write errors safely
    }
  },

  async upsertRows(tableName: CachedTableName, rows: any[], lastSyncTime?: string): Promise<void> {
    if (rows.length === 0 && !lastSyncTime) return;
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const stores: string[] = lastSyncTime ? [tableName, 'meta'] : [tableName];
        const tx = db.transaction(stores, 'readwrite');
        const store = tx.objectStore(tableName);
        for (const row of rows) {
          if (row && row.id !== undefined && row.id !== null) {
            store.put(row);
          }
        }
        if (lastSyncTime) {
          const metaStore = tx.objectStore('meta');
          const countReq = store.count();
          countReq.onsuccess = () => {
            metaStore.put({
              tableName,
              lastSyncTime,
              rowCount: countReq.result,
            });
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore cache write errors safely
    }
  },

  async deleteRowsByIds(tableName: CachedTableName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(tableName, 'readwrite');
        const store = tx.objectStore(tableName);
        for (const id of ids) {
          store.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore cache write errors safely
    }
  },

  async clearAll(): Promise<void> {
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([...CACHED_LARGE_TABLES, 'meta'], 'readwrite');
        for (const table of CACHED_LARGE_TABLES) {
          tx.objectStore(table).clear();
        }
        tx.objectStore('meta').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore cache clear errors
    }
  },
};

import dotenv from 'dotenv';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import { pool, query, withTransaction, translatePgError } from './db.js';

const envResult = dotenv.config({ override: true });
const app = express();
const PORT = Number(envResult.parsed?.PORT || process.env.BACKEND_PORT || 5000);
const TOKEN_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://ais-dev-4qgyzl4sbefljeofa2nwqw-81411647944.asia-east1.run.app',
  'https://ais-pre-4qgyzl4sbefljeofa2nwqw-81411647944.asia-east1.run.app',
  ...(process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : []),
]);

app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} tidak diizinkan oleh CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '15mb' }));

// --- Auth Token Utilities (HMAC-SHA256) ---
function signToken(payload) {
  const data = {
    ...payload,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPassword(inputPassword, storedPassword) {
  if (typeof inputPassword !== 'string' || typeof storedPassword !== 'string') return false;
  if (storedPassword.startsWith('scrypt:')) {
    const parts = storedPassword.split(':');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const hashHex = parts[2];
    const derived = crypto.scryptSync(inputPassword, salt, 64);
    const storedBuf = Buffer.from(hashHex, 'hex');
    if (derived.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derived, storedBuf);
  }
  const inputBuf = Buffer.from(inputPassword, 'utf8');
  const storedBuf = Buffer.from(storedPassword, 'utf8');
  if (inputBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(inputBuf, storedBuf);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sesi login tidak ditemukan atau telah berakhir. Silakan login kembali.' });
  }
  const token = authHeader.slice(7).trim();
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Token sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali.' });
  }
  req.authUser = { user: payload.user, role: payload.role || 'admin' };
  return next();
}

// --- Schema Introspection Cache ---
const tableColumnsCache = new Map();

async function getTableColumns(tableName, client = pool) {
  if (tableColumnsCache.has(tableName)) {
    return tableColumnsCache.get(tableName);
  }
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  const colSet = new Set(rows.map((r) => r.column_name));
  if (colSet.size > 0) {
    tableColumnsCache.set(tableName, colSet);
  }
  return colSet;
}

async function getPlateColumnName(client = pool) {
  const cols = await getTableColumns('master_plates', client);
  if (cols.has('plate_number')) return 'plate_number';
  if (cols.has('plat')) return 'plat';
  return 'plate_number';
}

// --- Activity Log Helper ---
async function insertActivityLog(client, username, action, targetTable, targetId = null, details = null) {
  try {
    await client.query(
      `INSERT INTO activity_logs (username, action, target_table, target_id, details) VALUES ($1, $2, $3, $4, $5)`,
      [
        username || 'system',
        action,
        targetTable,
        targetId || null,
        details !== undefined && details !== null ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    console.warn('[activity_logs] Skip log:', err.message);
  }
}

// --- Transactional Stock Adjustment Helper ---
async function applyBatchStockAdjustments(client, adjustments, username, skipActivityLog = false) {
  const validAdjustments = (adjustments || []).filter(
    (a) => a && a.itemName && Math.abs(Number(a.change) || 0) >= 0.000001
  );
  if (validAdjustments.length === 0) return;

  const { rows: currentRows } = await client.query(
    `SELECT item_name, quantity FROM current_stock FOR UPDATE`
  );

  const stockLookup = new Map();
  for (const row of currentRows) {
    const norm = row.item_name.trim().toUpperCase();
    stockLookup.set(norm, {
      actualName: row.item_name,
      qty: Number(row.quantity) || 0,
      exists: true,
    });
  }

  const touchedNorms = new Set();

  for (const adj of validAdjustments) {
    const norm = adj.itemName.trim().toUpperCase();
    let entry = stockLookup.get(norm);
    if (!entry) {
      entry = { actualName: adj.itemName.trim(), qty: 0, exists: false };
      stockLookup.set(norm, entry);
    }

    const initialStock = entry.qty;
    const delta = Number(adj.change);
    const finalStock = initialStock + delta;
    entry.qty = finalStock;
    touchedNorms.add(norm);

    let logTimestamp = new Date().toISOString();
    if (adj.customDate) {
      const d = new Date(adj.customDate);
      d.setHours(23, 59, 59, 999);
      logTimestamp = d.toISOString();
    }

    await client.query(
      `INSERT INTO stock_logs (item_name, tipe, stok_awal, perubahan, stok_akhir, keterangan, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.actualName, adj.type, initialStock, delta, finalStock, adj.notes || '', logTimestamp]
    );
  }

  for (const norm of touchedNorms) {
    const entry = stockLookup.get(norm);
    if (entry.exists) {
      await client.query(
        `UPDATE current_stock SET quantity = $1, updated_at = now() WHERE item_name = $2`,
        [entry.qty, entry.actualName]
      );
    } else {
      await client.query(
        `INSERT INTO current_stock (item_name, quantity, updated_at) VALUES ($1, $2, now())`,
        [entry.actualName, entry.qty]
      );
    }
  }

  if (username && !skipActivityLog) {
    await insertActivityLog(client, username, 'UPDATE', 'current_stock', 'batch', {
      count: validAdjustments.length,
    });
  }
}

// --- Scoped Table Fetcher ---
const ALLOWED_TABLES = new Set([
  'master_coops',
  'master_customers',
  'master_items',
  'master_plates',
  'current_stock',
  'delivery_orders',
  'invoices',
  'expenses',
  'salaries',
  'ledger_entries',
  'stock_logs',
  'production_logs',
  'trading_purchases',
  'stock_disposals',
  'early_stock',
  'activity_logs',
]);

async function fetchSingleTableData(tableName) {
  switch (tableName) {
    case 'master_coops': {
      const { rows } = await query(`SELECT name, address FROM master_coops ORDER BY name ASC`);
      return rows;
    }
    case 'master_customers': {
      const { rows } = await query(`SELECT name, address FROM master_customers ORDER BY name ASC`);
      return rows;
    }
    case 'master_items': {
      const { rows } = await query(`SELECT name FROM master_items ORDER BY name ASC`);
      return rows;
    }
    case 'master_plates': {
      const col = await getPlateColumnName();
      const { rows } = await query(`SELECT ${col} AS plate_val FROM master_plates ORDER BY ${col} ASC`);
      return rows.map((r) => r.plate_val);
    }
    case 'current_stock': {
      const { rows } = await query(`SELECT item_name, quantity FROM current_stock ORDER BY item_name ASC`);
      return rows;
    }
    case 'delivery_orders': {
      const { rows } = await query(
        `SELECT id, nomor_sj, tanggal, customer, nama_item, qty_kirim, qty_diterima, retur, susut_selisih, timestamp
         FROM delivery_orders ORDER BY timestamp DESC`
      );
      return rows;
    }
    case 'invoices': {
      const { rows } = await query(
        `SELECT id, nomor_invoice, tanggal, timestamp, nomor_sj, customer, item_name, total, qty_diterima, harga, transfer, cash, keterangan, invoice_status
         FROM invoices ORDER BY timestamp DESC`
      );
      return rows;
    }
    case 'expenses': {
      const { rows } = await query(
        `SELECT id, tanggal, kategori, jumlah, description, created_at FROM expenses ORDER BY tanggal DESC`
      );
      return rows;
    }
    case 'salaries': {
      const { rows } = await query(
        `SELECT id, tanggal, nama_karyawan, gaji_harian, hari_kerja, kasbon, total_gaji, catatan, created_at FROM salaries ORDER BY tanggal DESC`
      );
      return rows;
    }
    case 'ledger_entries': {
      const { rows } = await query(
        `SELECT id, tanggal, timestamp, debit, credit, balance, customer_id, metode_bayar, keterangan FROM ledger_entries ORDER BY timestamp DESC`
      );
      return rows;
    }
    case 'stock_logs': {
      const { rows } = await query(
        `SELECT id, timestamp, tipe, item_name, stok_awal, perubahan, stok_akhir, keterangan FROM stock_logs ORDER BY timestamp DESC`
      );
      return rows;
    }
    case 'production_logs': {
      const { rows } = await query(
        `SELECT id, tanggal_produksi, mobil, nama_kandang, driver, ekor, kg, harga_beli_kg, kematian_ekor, kematian_kg, is_applied, plat, item_name, qty, timestamp
         FROM production_logs ORDER BY timestamp DESC`
      );
      return rows;
    }
    case 'trading_purchases': {
      const { rows } = await query(
        `SELECT id, tanggal, timestamp, item_name, kg, harga_per_kg, total_harga FROM trading_purchases ORDER BY tanggal DESC`
      );
      return rows;
    }
    case 'stock_disposals': {
      const { rows } = await query(
        `SELECT id, tanggal, timestamp, item_name, kg, harga_valuasi_kg, total_kerugian, keterangan FROM stock_disposals ORDER BY tanggal DESC`
      );
      return rows;
    }
    case 'early_stock': {
      try {
        const { rows } = await query(
          `SELECT tanggal, item_name, ending_stock FROM early_stock ORDER BY tanggal DESC`
        );
        return rows;
      } catch (err) {
        if (err.code === '42P01') return [];
        throw err;
      }
    }
    case 'activity_logs': {
      try {
        const { rows } = await query(`SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 1000`);
        return rows;
      } catch (err) {
        if (err.code === '42P01') return [];
        throw err;
      }
    }
    default:
      return [];
  }
}

// --- Public Routes ---
app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', database: process.env.DB_NAME || 'dpj_rpa', time: new Date().toISOString() });
  } catch (err) {
    const mapped = translatePgError(err);
    res.status(mapped.status).json({ status: 'error', error: mapped.message });
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? req.body?.user ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi.' });
    }

    // Rule 1: Kolom "user" di tabel users wajib ditulis dengan tanda kutip ganda
    const { rows } = await query(
      `SELECT id, "user", password, role FROM users WHERE "user" = $1 LIMIT 1`,
      [username]
    );

    if (rows.length === 0 || !verifyPassword(password, rows[0].password)) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    const found = rows[0];
    const role = found.role || 'admin';
    const token = signToken({ id: found.id, user: found.user, role });
    await insertActivityLog(pool, found.user, 'LOGIN', 'users', found.user);

    return res.json({
      id: found.id,
      user: found.user,
      role,
      token,
    });
  } catch (err) {
    return next(err);
  }
});

// Protect all subsequent /api routes
app.use('/api', requireAuth);

// --- Multi-Table & Backup Endpoints ---
app.get('/api/tables', async (req, res, next) => {
  try {
    const namesParam = String(req.query.names || '');
    const names = Array.from(
      new Set(
        namesParam
          .split(',')
          .map((s) => s.trim())
          .filter((s) => ALLOWED_TABLES.has(s))
      )
    );
    if (names.length === 0) {
      return res.json({});
    }
    const entries = await Promise.all(
      names.map(async (name) => [name, await fetchSingleTableData(name)])
    );
    res.json(Object.fromEntries(entries));
  } catch (err) {
    next(err);
  }
});

app.get('/api/initial-data', async (_req, res, next) => {
  try {
    const [
      coops,
      customers,
      masterItems,
      plates,
      currentStock,
      deliveryOrders,
      invoices,
      expenses,
      salaries,
      ledger,
      stockLogs,
      productionLogs,
      tradingPurchases,
      stockDisposals,
      earlyStock,
    ] = await Promise.all([
      fetchSingleTableData('master_coops'),
      fetchSingleTableData('master_customers'),
      fetchSingleTableData('master_items'),
      fetchSingleTableData('master_plates'),
      fetchSingleTableData('current_stock'),
      fetchSingleTableData('delivery_orders'),
      fetchSingleTableData('invoices'),
      fetchSingleTableData('expenses'),
      fetchSingleTableData('salaries'),
      fetchSingleTableData('ledger_entries'),
      fetchSingleTableData('stock_logs'),
      fetchSingleTableData('production_logs'),
      fetchSingleTableData('trading_purchases'),
      fetchSingleTableData('stock_disposals'),
      fetchSingleTableData('early_stock'),
    ]);

    res.json({
      coops,
      customers,
      masterItems,
      plates,
      currentStock,
      deliveryOrders,
      invoices,
      expenses,
      salaries,
      ledger,
      stockLogs,
      productionLogs,
      tradingPurchases,
      stockDisposals,
      earlyStock,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/backup/:table', async (req, res, next) => {
  try {
    const table = req.params.table;
    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ error: `Tabel "${table}" tidak valid.` });
    }
    const { rows } = await query(`SELECT * FROM ${table}`);
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    next(err);
  }
});

// --- Master Items ---
app.get('/api/master_items', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, created_at FROM master_items ORDER BY name ASC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/master_items', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: 'Nama item wajib diisi.' });
    const username = req.body?.username || req.authUser.user;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO master_items (name) VALUES ($1) RETURNING id, name, created_at`,
        [name]
      );
      await insertActivityLog(client, username, 'ADD_MASTER', 'master_items', name, { name });
      return rows[0];
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.put('/api/master_items/:name', async (req, res, next) => {
  try {
    const oldName = decodeURIComponent(req.params.name).trim().toUpperCase();
    const newName = String(req.body?.name || '').trim().toUpperCase();
    if (!newName) return res.status(400).json({ error: 'Nama item baru wajib diisi.' });

    const { rows } = await query(
      `UPDATE master_items SET name = $1 WHERE name = $2 RETURNING id, name, created_at`,
      [newName, oldName]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/master_items/:name', async (req, res, next) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    const username = req.query.username || req.authUser.user;
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM master_items WHERE name = $1 RETURNING *`, [name]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE_MASTER', 'master_items', name, { identifier: name });
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Item tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Master Coops ---
app.get('/api/master_coops', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, address, created_at FROM master_coops ORDER BY name ASC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/master_coops', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().toUpperCase();
    const address = String(req.body?.address || '').trim();
    if (!name) return res.status(400).json({ error: 'Nama kandang wajib diisi.' });
    const username = req.body?.username || req.authUser.user;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO master_coops (name, address) VALUES ($1, $2) RETURNING id, name, address, created_at`,
        [name, address]
      );
      await insertActivityLog(client, username, 'ADD_MASTER', 'master_coops', name, { name, address });
      return rows[0];
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.put('/api/master_coops/:name', async (req, res, next) => {
  try {
    const oldName = decodeURIComponent(req.params.name).trim().toUpperCase();
    const newName = String(req.body?.name || oldName).trim().toUpperCase();
    const address = String(req.body?.address || '').trim();
    const { rows } = await query(
      `UPDATE master_coops SET name = $1, address = $2 WHERE name = $3 RETURNING id, name, address, created_at`,
      [newName, address, oldName]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Kandang tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/master_coops/:name', async (req, res, next) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    const username = req.query.username || req.authUser.user;
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM master_coops WHERE name = $1 RETURNING *`, [name]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE_MASTER', 'master_coops', name, { identifier: name });
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Kandang tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Master Customers ---
app.get('/api/master_customers', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, name, address, created_at FROM master_customers ORDER BY name ASC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/master_customers', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().toUpperCase();
    const address = String(req.body?.address || '').trim();
    if (!name) return res.status(400).json({ error: 'Nama customer wajib diisi.' });
    const username = req.body?.username || req.authUser.user;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO master_customers (name, address) VALUES ($1, $2) RETURNING id, name, address, created_at`,
        [name, address]
      );
      await insertActivityLog(client, username, 'ADD_MASTER', 'master_customers', name, { name, address });
      return rows[0];
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.put('/api/master_customers/:name', async (req, res, next) => {
  try {
    const oldName = decodeURIComponent(req.params.name).trim().toUpperCase();
    const newName = String(req.body?.newName ?? req.body?.name ?? '').trim().toUpperCase();
    const newAddress = String(req.body?.newAddress ?? req.body?.address ?? '').trim();
    const username = req.body?.username || req.authUser.user;

    if (!newName) return res.status(400).json({ error: 'Nama customer baru wajib diisi.' });

    const updated = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE master_customers SET name = $1, address = $2 WHERE name = $3 RETURNING id, name, address, created_at`,
        [newName, newAddress, oldName]
      );
      if (rows.length === 0) return null;

      // ledger_entries.customer_id has no FK, so update explicitly alongside ON UPDATE CASCADE tables
      await client.query(`UPDATE ledger_entries SET customer_id = $1 WHERE customer_id = $2`, [newName, oldName]);
      await client.query(`UPDATE delivery_orders SET customer = $1 WHERE customer = $2`, [newName, oldName]);
      await client.query(`UPDATE invoices SET customer = $1 WHERE customer = $2`, [newName, oldName]);

      await insertActivityLog(client, username, 'UPDATE_CUSTOMER_NAME', 'master_customers', oldName, {
        oldName,
        newName,
      });
      return rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'Customer tidak ditemukan.' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/master_customers/:name', async (req, res, next) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    const username = req.query.username || req.authUser.user;
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM master_customers WHERE name = $1 RETURNING *`, [name]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE_MASTER', 'master_customers', name, { identifier: name });
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Customer tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Master Plates ---
app.get('/api/master_plates', async (_req, res, next) => {
  try {
    const col = await getPlateColumnName();
    const { rows } = await query(`SELECT id, ${col} AS plat, created_at FROM master_plates ORDER BY ${col} ASC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/master_plates', async (req, res, next) => {
  try {
    const plate = String(req.body?.plat ?? req.body?.plate_number ?? req.body?.plate ?? '').trim().toUpperCase();
    if (!plate) return res.status(400).json({ error: 'Plat nomor wajib diisi.' });
    const username = req.body?.username || req.authUser.user;

    const result = await withTransaction(async (client) => {
      const col = await getPlateColumnName(client);
      const { rows } = await client.query(
        `INSERT INTO master_plates (${col}) VALUES ($1) RETURNING id, ${col} AS plat, created_at`,
        [plate]
      );
      await insertActivityLog(client, username, 'ADD_MASTER', 'master_plates', plate, { plate });
      return rows[0];
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.put('/api/master_plates/:plate', async (req, res, next) => {
  try {
    const oldPlate = decodeURIComponent(req.params.plate).trim().toUpperCase();
    const newPlate = String(req.body?.plat ?? req.body?.plate_number ?? '').trim().toUpperCase();
    if (!newPlate) return res.status(400).json({ error: 'Plat nomor baru wajib diisi.' });

    const col = await getPlateColumnName();
    const { rows } = await query(
      `UPDATE master_plates SET ${col} = $1 WHERE ${col} = $2 RETURNING id, ${col} AS plat, created_at`,
      [newPlate, oldPlate]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Plat nomor tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/master_plates/:plate', async (req, res, next) => {
  try {
    const plate = decodeURIComponent(req.params.plate).trim();
    const username = req.query.username || req.authUser.user;
    const deleted = await withTransaction(async (client) => {
      const col = await getPlateColumnName(client);
      const { rows } = await client.query(`DELETE FROM master_plates WHERE ${col} = $1 RETURNING *`, [plate]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE_MASTER', 'master_plates', plate, { identifier: plate });
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Plat nomor tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Current Stock & Stock Logs & Opname ---
app.get('/api/current_stock', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, item_name, quantity, updated_at FROM current_stock ORDER BY item_name ASC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/stock_logs', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, timestamp, tipe, item_name, stok_awal, perubahan, stok_akhir, keterangan FROM stock_logs ORDER BY timestamp DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/current_stock/adjust', async (req, res, next) => {
  try {
    const { itemName, change, type, notes, username, skipLog, customDate } = req.body || {};
    if (!itemName || isNaN(Number(change))) {
      return res.status(400).json({ error: 'itemName dan change wajib diisi.' });
    }
    const actor = username || req.authUser.user;

    await withTransaction(async (client) => {
      await applyBatchStockAdjustments(
        client,
        [{ itemName, change: Number(change), type: type || 'Penyesuaian', notes: notes || '', customDate }],
        actor,
        Boolean(skipLog) || type === 'Produksi'
      );
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/stock_opname', async (req, res, next) => {
  try {
    const { items = [], date, isToday, username } = req.body || {};
    const actor = username || req.authUser.user;

    const result = await withTransaction(async (client) => {
      const validEntries = items.filter((it) => it && it.itemName && !isNaN(Number(it.targetQty)));
      const skipInvalidCount = items.length - validEntries.length;

      const { rows: allCurrentStock } = await client.query(
        `SELECT item_name, quantity FROM current_stock FOR UPDATE`
      );
      const stockMap = new Map();
      for (const row of allCurrentStock) {
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

      const changedItems = [];
      for (const { itemName, targetQty } of validEntries) {
        const normName = itemName.trim().toUpperCase();
        const existing = stockMap.get(normName);
        const effectiveItemName = existing ? existing.actualName : itemName.trim();
        const liveStockNow = existing ? existing.qty : 0;

        let systemQtyAtRefPoint = liveStockNow;
        if (!isToday) {
          const { rows: logs } = await client.query(
            `SELECT stok_akhir FROM stock_logs WHERE LOWER(item_name) = LOWER($1) AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 1`,
            [effectiveItemName, filterDateIso]
          );
          if (logs.length > 0) {
            systemQtyAtRefPoint = Number(logs[0].stok_akhir);
          } else {
            const { rows: futureLogs } = await client.query(
              `SELECT stok_awal FROM stock_logs WHERE LOWER(item_name) = LOWER($1) AND timestamp > $2 ORDER BY timestamp ASC LIMIT 1`,
              [effectiveItemName, filterDateIso]
            );
            if (futureLogs.length > 0) {
              systemQtyAtRefPoint = Number(futureLogs[0].stok_awal);
            }
          }
        }

        const variance = Number(targetQty) - systemQtyAtRefPoint;
        if (Math.abs(variance) >= 0.000001) {
          changedItems.push({
            effectiveItemName,
            targetQty: Number(targetQty),
            systemQtyAtRefPoint,
            variance,
            newLiveStock: liveStockNow + variance,
            exists: Boolean(existing),
          });
        }
      }

      const skipCount = skipInvalidCount + (validEntries.length - changedItems.length);
      if (changedItems.length === 0) {
        return { updatedCount: 0, skipCount, errorCount: 0, errors: [] };
      }

      const logTimestamp = isToday ? new Date().toISOString() : filterDateIso;
      let updatedCount = 0;

      for (const r of changedItems) {
        if (r.exists) {
          await client.query(
            `UPDATE current_stock SET quantity = $1, updated_at = now() WHERE item_name = $2`,
            [r.newLiveStock, r.effectiveItemName]
          );
        } else {
          await client.query(
            `INSERT INTO current_stock (item_name, quantity, updated_at) VALUES ($1, $2, now())`,
            [r.effectiveItemName, r.newLiveStock]
          );
        }

        await client.query(
          `INSERT INTO stock_logs (item_name, tipe, stok_awal, perubahan, stok_akhir, keterangan, timestamp)
           VALUES ($1, 'Opname', $2, $3, $4, $5, $6)`,
          [r.effectiveItemName, r.systemQtyAtRefPoint, r.variance, r.targetQty, `Opname tanggal ${date}`, logTimestamp]
        );
        updatedCount++;
      }

      await insertActivityLog(client, actor, 'SYNC_OPNAME', 'current_stock', date, {
        count: changedItems.length,
        date,
      });

      return { updatedCount, skipCount, errorCount: 0, errors: [] };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Production Logs ---
app.get('/api/production_logs', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tanggal_produksi, item_name, qty, ekor, kg, mobil, harga_beli_kg, kematian_ekor, kematian_kg, nama_kandang, driver, is_applied, plat, timestamp
       FROM production_logs ORDER BY timestamp DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/production_logs', async (req, res, next) => {
  try {
    const logs = Array.isArray(req.body?.logs) ? req.body.logs : [req.body];
    const autoApply = Boolean(req.body?.autoApply);
    const username = req.body?.username || req.authUser.user;

    if (logs.length === 0) {
      return res.status(400).json({ error: 'Data produksi tidak boleh kosong.' });
    }

    const inserted = await withTransaction(async (client) => {
      const createdRows = [];
      for (const l of logs) {
        const { rows } = await client.query(
          `INSERT INTO production_logs (
            tanggal_produksi, item_name, qty, ekor, kg, mobil,
            harga_beli_kg, kematian_ekor, kematian_kg, nama_kandang, driver, is_applied, plat
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *`,
          [
            l.tanggal_produksi,
            l.item_name,
            Number(l.qty) || 0,
            Number(l.ekor) || 0,
            Number(l.kg) || 0,
            String(l.mobil || ''),
            Number(l.harga_beli_kg) || 0,
            Number(l.kematian_ekor) || 0,
            Number(l.kematian_kg) || 0,
            l.nama_kandang,
            l.driver || null,
            autoApply,
            l.plat || null,
          ]
        );
        createdRows.push(rows[0]);
      }

      if (autoApply) {
        await applyBatchStockAdjustments(
          client,
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

      await insertActivityLog(client, username, 'CREATE', 'production_logs', 'multiple', {
        count: logs.length,
        autoApply,
      });
      return createdRows;
    });

    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
});

app.put('/api/production_logs/apply', async (req, res, next) => {
  try {
    const { date, truckNumber, username } = req.body || {};
    const actor = username || req.authUser.user;

    const appliedCount = await withTransaction(async (client) => {
      const { rows: logs } = await client.query(
        `SELECT * FROM production_logs WHERE tanggal_produksi = $1 AND mobil = $2 AND is_applied = FALSE FOR UPDATE`,
        [date, String(truckNumber)]
      );
      if (logs.length === 0) return 0;

      await applyBatchStockAdjustments(
        client,
        logs.map((log) => ({
          itemName: log.item_name,
          change: Number(log.qty),
          type: 'Produksi',
          notes: `Apply Stok: Mobil ${truckNumber} (${date})`,
        })),
        actor,
        true
      );

      await client.query(
        `UPDATE production_logs SET is_applied = TRUE WHERE tanggal_produksi = $1 AND mobil = $2`,
        [date, String(truckNumber)]
      );
      await insertActivityLog(client, actor, 'UPDATE', 'production_logs', `${date}-${truckNumber}`, {
        date,
        truckNumber,
        applied: true,
      });
      return logs.length;
    });

    res.json({ success: true, appliedCount });
  } catch (err) {
    next(err);
  }
});

app.put('/api/production_logs/prices', async (req, res, next) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const username = req.body?.username || req.authUser.user;
    if (updates.length === 0) return res.json({ success: true });

    await withTransaction(async (client) => {
      const recordIds = updates.map((u) => u.recordId).filter(Boolean);
      const { rows: records } = await client.query(
        `SELECT id, tanggal_produksi, mobil FROM production_logs WHERE id = ANY($1::uuid[])`,
        [recordIds]
      );
      const recordMap = new Map(records.map((r) => [r.id, r]));
      const batchUpdates = new Map();

      for (const u of updates) {
        const rec = recordMap.get(u.recordId);
        if (rec) {
          batchUpdates.set(`${rec.tanggal_produksi}::${rec.mobil}`, {
            date: rec.tanggal_produksi,
            mobil: rec.mobil,
            pricePerKg: Number(u.pricePerKg) || 0,
          });
        }
      }

      for (const b of batchUpdates.values()) {
        await client.query(
          `UPDATE production_logs SET harga_beli_kg = $1 WHERE tanggal_produksi = $2 AND mobil = $3`,
          [b.pricePerKg, b.date, b.mobil]
        );
      }

      const affectedDates = Array.from(new Set(Array.from(batchUpdates.values()).map((b) => b.date)));
      await insertActivityLog(client, username, 'UPDATE', 'production_logs', 'prices', { dates: affectedDates });
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/production_logs/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const p = req.body || {};
    const { rows } = await query(
      `UPDATE production_logs
       SET tanggal_produksi = $1, item_name = $2, qty = $3, ekor = $4, kg = $5, mobil = $6,
           harga_beli_kg = $7, kematian_ekor = $8, kematian_kg = $9, nama_kandang = $10, driver = $11, plat = $12
       WHERE id = $13 RETURNING *`,
      [
        p.tanggal_produksi,
        p.item_name,
        Number(p.qty) || 0,
        Number(p.ekor) || 0,
        Number(p.kg) || 0,
        String(p.mobil || ''),
        Number(p.harga_beli_kg) || 0,
        Number(p.kematian_ekor) || 0,
        Number(p.kematian_kg) || 0,
        p.nama_kandang,
        p.driver || null,
        p.plat || null,
        id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Data produksi tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/production_logs/batch', async (req, res, next) => {
  try {
    const date = String(req.query.date || req.body?.date || '');
    const truckNumber = String(req.query.truckNumber || req.body?.truckNumber || '');
    const username = String(req.query.username || req.body?.username || req.authUser.user);

    await withTransaction(async (client) => {
      const { rows: logs } = await client.query(
        `SELECT * FROM production_logs WHERE tanggal_produksi = $1 AND mobil = $2 FOR UPDATE`,
        [date, truckNumber]
      );
      if (logs.length === 0) return;

      const appliedAdjustments = logs
        .filter((l) => l.is_applied)
        .map((log) => ({
          itemName: log.item_name,
          change: -Number(log.qty),
          type: 'Hapus Produksi',
          notes: `REVERSAL: Hapus Mobil ${truckNumber} (${date})`,
        }));

      if (appliedAdjustments.length > 0) {
        await applyBatchStockAdjustments(client, appliedAdjustments, username, true);
      }

      await client.query(
        `DELETE FROM production_logs WHERE tanggal_produksi = $1 AND mobil = $2`,
        [date, truckNumber]
      );
      await insertActivityLog(client, username, 'DELETE', 'production_logs', `${date}-${truckNumber}`, {
        date,
        truckNumber,
      });
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/production_logs/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = req.query.username || req.authUser.user;
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM production_logs WHERE id = $1 FOR UPDATE`, [id]);
      if (rows.length === 0) return null;
      const log = rows[0];
      if (log.is_applied) {
        await applyBatchStockAdjustments(
          client,
          [{ itemName: log.item_name, change: -Number(log.qty), type: 'Hapus Produksi', notes: `Hapus item produksi (${log.tanggal_produksi})` }],
          username,
          true
        );
      }
      await client.query(`DELETE FROM production_logs WHERE id = $1`, [id]);
      await insertActivityLog(client, username, 'DELETE', 'production_logs', id);
      return log;
    });
    if (!deleted) return res.status(404).json({ error: 'Data produksi tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Trading Purchases (Rule 2: NEVER include total_harga in INSERT or UPDATE) ---
app.get('/api/trading_purchases', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tanggal, item_name, kg, harga_per_kg, total_harga, timestamp FROM trading_purchases ORDER BY tanggal DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/trading_purchases', async (req, res, next) => {
  try {
    const payload = req.body?.data || req.body || {};
    const username = req.body?.username || req.authUser.user;

    const created = await withTransaction(async (client) => {
      // total_harga is GENERATED ALWAYS AS (kg * harga_per_kg) STORED — omitted intentionally
      const { rows } = await client.query(
        `INSERT INTO trading_purchases (tanggal, item_name, kg, harga_per_kg)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tanggal, item_name, kg, harga_per_kg, total_harga, timestamp`,
        [payload.tanggal, payload.item_name, Number(payload.kg), Number(payload.harga_per_kg)]
      );

      await applyBatchStockAdjustments(
        client,
        [{ itemName: payload.item_name, change: Number(payload.kg), type: 'Pembelian', notes: `Trading Purchase (${payload.tanggal})` }],
        username
      );
      await insertActivityLog(client, username, 'CREATE', 'trading_purchases', rows[0].id, {
        item: payload.item_name,
        kg: payload.kg,
      });
      return rows[0];
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.put('/api/trading_purchases/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const payload = req.body?.data || req.body || {};
    const username = req.body?.username || req.authUser.user;

    const updated = await withTransaction(async (client) => {
      const { rows: origRows } = await client.query(`SELECT * FROM trading_purchases WHERE id = $1 FOR UPDATE`, [id]);
      if (origRows.length === 0) return null;
      const original = origRows[0];

      await applyBatchStockAdjustments(
        client,
        [
          { itemName: original.item_name, change: -Number(original.kg), type: 'Edit Pembelian', notes: `Reversal Edit Trading Purchase (${original.tanggal})` },
          { itemName: payload.item_name, change: Number(payload.kg), type: 'Edit Pembelian', notes: `Apply Edit Trading Purchase (${payload.tanggal})` },
        ],
        username
      );

      // total_harga is GENERATED ALWAYS AS (kg * harga_per_kg) STORED — omitted intentionally
      const { rows } = await client.query(
        `UPDATE trading_purchases
         SET tanggal = $1, item_name = $2, kg = $3, harga_per_kg = $4
         WHERE id = $5
         RETURNING id, tanggal, item_name, kg, harga_per_kg, total_harga, timestamp`,
        [payload.tanggal, payload.item_name, Number(payload.kg), Number(payload.harga_per_kg), id]
      );

      await insertActivityLog(client, username, 'UPDATE', 'trading_purchases', id, {
        new_data: payload,
        old_data: original,
      });
      return rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'Data pembelian trading tidak ditemukan.' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/trading_purchases/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = req.query.username || req.authUser.user;

    const deleted = await withTransaction(async (client) => {
      const { rows: origRows } = await client.query(`SELECT * FROM trading_purchases WHERE id = $1 FOR UPDATE`, [id]);
      if (origRows.length === 0) return null;
      const original = origRows[0];

      await applyBatchStockAdjustments(
        client,
        [{ itemName: original.item_name, change: -Number(original.kg), type: 'Hapus Pembelian', notes: `Reversal Hapus Trading Purchase (${original.tanggal})` }],
        username
      );
      await client.query(`DELETE FROM trading_purchases WHERE id = $1`, [id]);
      await insertActivityLog(client, username, 'DELETE', 'trading_purchases', id);
      return original;
    });

    if (!deleted) return res.status(404).json({ error: 'Data pembelian trading tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Stock Disposals (Rule 2: NEVER include total_kerugian in INSERT or UPDATE) ---
app.get('/api/stock_disposals', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tanggal, item_name, kg, harga_valuasi_kg, total_kerugian, keterangan, timestamp FROM stock_disposals ORDER BY tanggal DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/stock_disposals', async (req, res, next) => {
  try {
    const payload = req.body?.data || req.body || {};
    const username = req.body?.username || req.authUser.user;

    const created = await withTransaction(async (client) => {
      // total_kerugian is GENERATED ALWAYS AS (kg * harga_valuasi_kg) STORED — omitted intentionally
      const { rows } = await client.query(
        `INSERT INTO stock_disposals (tanggal, item_name, kg, harga_valuasi_kg, keterangan)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tanggal, item_name, kg, harga_valuasi_kg, total_kerugian, keterangan, timestamp`,
        [payload.tanggal, payload.item_name, Number(payload.kg), Number(payload.harga_valuasi_kg), payload.keterangan || '']
      );

      await applyBatchStockAdjustments(
        client,
        [{ itemName: payload.item_name, change: -Number(payload.kg), type: 'Pemusnahan', notes: `Pemusnahan: ${payload.keterangan || ''}` }],
        username
      );
      await insertActivityLog(client, username, 'CREATE', 'stock_disposals', rows[0].id, {
        item: payload.item_name,
        kg: payload.kg,
      });
      return rows[0];
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.put('/api/stock_disposals/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const payload = req.body?.data || req.body || {};
    const username = req.body?.username || req.authUser.user;

    const updated = await withTransaction(async (client) => {
      const { rows: origRows } = await client.query(`SELECT * FROM stock_disposals WHERE id = $1 FOR UPDATE`, [id]);
      if (origRows.length === 0) return null;
      const original = origRows[0];

      await applyBatchStockAdjustments(
        client,
        [
          { itemName: original.item_name, change: Number(original.kg), type: 'Edit Pemusnahan', notes: `Reversal Edit Pemusnahan (${original.tanggal})` },
          { itemName: payload.item_name, change: -Number(payload.kg), type: 'Edit Pemusnahan', notes: `Apply Edit Pemusnahan (${payload.tanggal})` },
        ],
        username
      );

      // total_kerugian is GENERATED ALWAYS AS (kg * harga_valuasi_kg) STORED — omitted intentionally
      const { rows } = await client.query(
        `UPDATE stock_disposals
         SET tanggal = $1, item_name = $2, kg = $3, harga_valuasi_kg = $4, keterangan = $5
         WHERE id = $6
         RETURNING id, tanggal, item_name, kg, harga_valuasi_kg, total_kerugian, keterangan, timestamp`,
        [payload.tanggal, payload.item_name, Number(payload.kg), Number(payload.harga_valuasi_kg), payload.keterangan || '', id]
      );

      await insertActivityLog(client, username, 'UPDATE', 'stock_disposals', id, {
        new_data: payload,
        old_data: original,
      });
      return rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'Data pemusnahan stok tidak ditemukan.' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/stock_disposals/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = req.query.username || req.authUser.user;

    const deleted = await withTransaction(async (client) => {
      const { rows: origRows } = await client.query(`SELECT * FROM stock_disposals WHERE id = $1 FOR UPDATE`, [id]);
      if (origRows.length === 0) return null;
      const original = origRows[0];

      await applyBatchStockAdjustments(
        client,
        [{ itemName: original.item_name, change: Number(original.kg), type: 'Hapus Pemusnahan', notes: `Reversal Hapus Pemusnahan (${original.tanggal})` }],
        username
      );
      await client.query(`DELETE FROM stock_disposals WHERE id = $1`, [id]);
      await insertActivityLog(client, username, 'DELETE', 'stock_disposals', id);
      return original;
    });

    if (!deleted) return res.status(404).json({ error: 'Data pemusnahan stok tidak ditemukan.' });
    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- Delivery Orders ---
async function insertDeliveryOrderRows(client, rowsToInsert) {
  const doCols = await getTableColumns('delivery_orders', client);
  const hasExtendedCols = doCols.has('qty_kirim2') && doCols.has('qty_diterima2');

  const inserted = [];
  for (const item of rowsToInsert) {
    if (hasExtendedCols) {
      const { rows } = await client.query(
        `INSERT INTO delivery_orders (tanggal, nomor_sj, customer, nama_item, qty_kirim, qty_kirim2, qty_diterima, qty_diterima2, retur)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          item.tanggal,
          item.nomor_sj,
          item.customer,
          item.nama_item,
          Number(item.qty_kirim) || 0,
          Number(item.qty_kirim2 ?? item.qty_kirim) || 0,
          Number(item.qty_diterima) || 0,
          Number(item.qty_diterima2 ?? item.qty_diterima) || 0,
          Number(item.retur) || 0,
        ]
      );
      inserted.push(rows[0]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO delivery_orders (tanggal, nomor_sj, customer, nama_item, qty_kirim, qty_diterima, retur)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          item.tanggal,
          item.nomor_sj,
          item.customer,
          item.nama_item,
          Number(item.qty_kirim) || 0,
          Number(item.qty_diterima) || 0,
          Number(item.retur) || 0,
        ]
      );
      inserted.push(rows[0]);
    }
  }
  return inserted;
}

app.get('/api/delivery_orders', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM delivery_orders ORDER BY timestamp DESC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/delivery_orders', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    const username = req.body?.username || req.authUser.user;

    if (items.length === 0) return res.status(400).json({ error: 'Item Surat Jalan tidak boleh kosong.' });

    const inserted = await withTransaction(async (client) => {
      const created = await insertDeliveryOrderRows(client, items);

      const adjustments = items
        .filter((item) => (item.qty_kirim2 !== undefined ? Number(item.qty_kirim2) : Number(item.qty_kirim)) > 0)
        .map((item) => ({
          itemName: item.nama_item,
          change: -(item.qty_kirim2 !== undefined ? Number(item.qty_kirim2) : Number(item.qty_kirim)),
          type: 'Alokasi',
          notes: `SJ ${item.nomor_sj} untuk ${item.customer}`,
        }));

      await applyBatchStockAdjustments(client, adjustments, username);
      await insertActivityLog(client, username, 'CREATE', 'delivery_orders', items[0]?.nomor_sj, {
        count: items.length,
      });
      return created;
    });

    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
});

async function handleUpdateDeliveryOrder(sjNumber, body, authUser) {
  const order = body?.order || body;
  const mode = body?.mode || 'detail';
  const username = body?.username || authUser.user;

  return withTransaction(async (client) => {
    const { rows: previousData } = await client.query(
      `SELECT id, nama_item, retur, qty_kirim FROM delivery_orders WHERE nomor_sj = $1 FOR UPDATE`,
      [sjNumber]
    );

    const stockAdjustments = [];

    if (mode === 'invoice_sync') {
      for (const it of order.items || []) {
        const prevItem = previousData.find((prev) => prev.nama_item === it.name);
        const qtyKirim = Number(it.quantity) || 0;
        const prevQtyKirim = prevItem ? Number(prevItem.qty_kirim) : 0;
        if (qtyKirim !== prevQtyKirim) {
          stockAdjustments.push({
            itemName: it.name,
            change: -(qtyKirim - prevQtyKirim),
            type: 'Alokasi',
            notes: `Update kuantitas SJ ${sjNumber} dari Invoice: dari ${prevQtyKirim} menjadi ${qtyKirim}`,
          });
        }
      }
      for (const prev of previousData) {
        if (!(order.items || []).some((it) => it.name === prev.nama_item)) {
          const kgQty = Number(prev.qty_kirim) || 0;
          if (kgQty > 0) {
            stockAdjustments.push({
              itemName: prev.nama_item,
              change: kgQty,
              type: 'Alokasi',
              notes: `Hapus item SJ ${sjNumber} dari Invoice`,
            });
          }
        }
      }
    } else {
      if (previousData.length > 0) {
        for (const prev of previousData) {
          const kgRetur = Number(prev.retur || 0);
          if (kgRetur > 0) {
            stockAdjustments.push({
              itemName: prev.nama_item,
              change: -kgRetur,
              type: 'Alokasi',
              notes: `Koreksi Retur SJ ${sjNumber}`,
            });
          }
        }

        const processedItems = new Set();
        for (const it of order.items || []) {
          processedItems.add(it.name);
          const prevItem = previousData.find((prev) => prev.nama_item === it.name);
          const qtyKirim = Number(it.quantity) || 0;
          const prevQtyKirim = prevItem ? Number(prevItem.qty_kirim) : 0;
          if (qtyKirim !== prevQtyKirim) {
            stockAdjustments.push({
              itemName: it.name,
              change: -(qtyKirim - prevQtyKirim),
              type: 'Alokasi',
              notes: `Update kuantitas Kirim SJ ${sjNumber}: dari ${prevQtyKirim} menjadi ${qtyKirim}`,
            });
          }

          const newRetur = order.rejectedItems?.find((ri) => ri.name === it.name)?.quantity || 0;
          const prevRetur = prevItem ? Number(prevItem.retur) : 0;
          if (newRetur !== prevRetur) {
            stockAdjustments.push({
              itemName: it.name,
              change: newRetur - prevRetur,
              type: 'Alokasi',
              notes: `Update kuantitas Retur SJ ${sjNumber}: dari ${prevRetur} menjadi ${newRetur}`,
            });
          }
        }

        for (const prev of previousData) {
          if (!processedItems.has(prev.nama_item)) {
            const kgNet = Number(prev.qty_kirim) - Number(prev.retur || 0);
            if (kgNet > 0) {
              stockAdjustments.push({
                itemName: prev.nama_item,
                change: kgNet,
                type: 'Alokasi',
                notes: `Hapus item SJ ${sjNumber} (Kembali ke stok)`,
              });
            }
          }
        }
      } else if (order.rejectedItems && order.rejectedItems.length > 0) {
        for (const item of order.rejectedItems) {
          const kgRetur = Number(item.quantity);
          if (kgRetur > 0) {
            stockAdjustments.push({
              itemName: item.name,
              change: kgRetur,
              type: 'Alokasi',
              notes: `Retur dari SJ ${sjNumber}`,
            });
          }
        }
      }
    }

    const dateStr =
      typeof order.date === 'string'
        ? order.date.slice(0, 10)
        : new Date(order.date).toISOString().slice(0, 10);

    const dbEntries = (order.items || []).map((it) => {
      const qtyKirim = Number(it.quantity) || 0;
      const qtyDiterima = order.receivedItems?.find((ri) => ri.name === it.name)?.quantity || 0;
      return {
        tanggal: dateStr,
        nomor_sj: sjNumber,
        customer: order.customer,
        nama_item: it.name,
        qty_kirim: qtyKirim,
        qty_kirim2: qtyKirim,
        qty_diterima: qtyDiterima,
        qty_diterima2: qtyDiterima,
        retur: order.rejectedItems?.find((ri) => ri.name === it.name)?.quantity || 0,
      };
    });

    await applyBatchStockAdjustments(client, stockAdjustments, username);
    await client.query(`DELETE FROM delivery_orders WHERE nomor_sj = $1`, [sjNumber]);
    const inserted = await insertDeliveryOrderRows(client, dbEntries);
    await insertActivityLog(client, username, 'UPDATE', 'delivery_orders', sjNumber, {
      count: dbEntries.length,
      ...(mode === 'invoice_sync' ? { source: 'invoice_sync' } : {}),
    });
    return inserted;
  });
}

app.put('/api/delivery_orders', async (req, res, next) => {
  try {
    const sjNumber = String(req.query.nomor_sj || req.body?.nomor_sj || req.body?.order?.id || '').trim();
    if (!sjNumber) return res.status(400).json({ error: 'nomor_sj wajib diisi.' });
    const updated = await handleUpdateDeliveryOrder(sjNumber, req.body, req.authUser);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.put('/api/delivery_orders/:nomor_sj', async (req, res, next) => {
  try {
    const sjNumber = decodeURIComponent(req.params.nomor_sj);
    const updated = await handleUpdateDeliveryOrder(sjNumber, req.body, req.authUser);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

async function handleDeleteDeliveryOrder(sjNumber, username) {
  return withTransaction(async (client) => {
    const { rows: orders } = await client.query(
      `SELECT * FROM delivery_orders WHERE nomor_sj = $1 FOR UPDATE`,
      [sjNumber]
    );
    if (orders.length === 0) return false;

    const stockAdjustments = [];
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

    await applyBatchStockAdjustments(client, stockAdjustments, username);
    await client.query(`DELETE FROM delivery_orders WHERE nomor_sj = $1`, [sjNumber]);
    await client.query(`DELETE FROM invoices WHERE nomor_sj = $1`, [sjNumber]);
    await insertActivityLog(
      client,
      username,
      'DELETE',
      'delivery_orders',
      sjNumber,
      `${username} Menghapus DO No ${sjNumber} customer ${orders[0].customer}`
    );
    return true;
  });
}

app.delete('/api/delivery_orders', async (req, res, next) => {
  try {
    const sjNumber = String(req.query.nomor_sj || '').trim();
    const username = String(req.query.username || req.authUser.user);
    if (!sjNumber) return res.status(400).json({ error: 'nomor_sj wajib diisi.' });
    await handleDeleteDeliveryOrder(sjNumber, username);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/delivery_orders/:nomor_sj', async (req, res, next) => {
  try {
    const sjNumber = decodeURIComponent(req.params.nomor_sj);
    const username = String(req.query.username || req.authUser.user);
    await handleDeleteDeliveryOrder(sjNumber, username);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Invoices ---
app.get('/api/invoices', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM invoices ORDER BY timestamp DESC`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/invoices', async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const username = req.body?.username || req.authUser.user;

    if (entries.length === 0) return res.status(400).json({ error: 'Item invoice tidak boleh kosong.' });

    const created = await withTransaction(async (client) => {
      const inserted = [];
      for (const inv of entries) {
        const { rows } = await client.query(
          `INSERT INTO invoices (
            tanggal, nomor_sj, nomor_invoice, customer, item_name,
            harga, total, transfer, cash, qty_diterima, keterangan, invoice_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [
            inv.tanggal,
            inv.nomor_sj || '',
            inv.nomor_invoice,
            inv.customer,
            inv.item_name,
            Number(inv.harga) || 0,
            Number(inv.total) || 0,
            Number(inv.transfer) || 0,
            Number(inv.cash) || 0,
            Number(inv.qty_diterima) || 0,
            inv.keterangan || '',
            inv.invoice_status || 'Unpaid',
          ]
        );
        inserted.push(rows[0]);
      }
      await insertActivityLog(client, username, 'CREATE', 'invoices', entries[0]?.nomor_invoice, {
        count: entries.length,
      });
      return inserted;
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

async function handleUpdateInvoice(invoiceId, body, authUser) {
  const entries = Array.isArray(body?.entries) ? body.entries : [body];
  const username = body?.username || authUser.user;

  return withTransaction(async (client) => {
    await client.query(`DELETE FROM invoices WHERE nomor_invoice = $1`, [invoiceId]);
    const inserted = [];
    for (const inv of entries) {
      const { rows } = await client.query(
        `INSERT INTO invoices (
          tanggal, nomor_sj, nomor_invoice, customer, item_name,
          harga, total, transfer, cash, qty_diterima, keterangan, invoice_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          inv.tanggal,
          inv.nomor_sj || '',
          inv.nomor_invoice || invoiceId,
          inv.customer,
          inv.item_name,
          Number(inv.harga) || 0,
          Number(inv.total) || 0,
          Number(inv.transfer) || 0,
          Number(inv.cash) || 0,
          Number(inv.qty_diterima) || 0,
          inv.keterangan || '',
          inv.invoice_status || 'Unpaid',
        ]
      );
      inserted.push(rows[0]);
    }
    await insertActivityLog(client, username, 'UPDATE', 'invoices', invoiceId, { count: entries.length });
    return inserted;
  });
}

app.put('/api/invoices', async (req, res, next) => {
  try {
    const invoiceId = String(req.query.nomor_invoice || req.body?.invoiceId || '').trim();
    if (!invoiceId) return res.status(400).json({ error: 'nomor_invoice wajib diisi.' });
    const updated = await handleUpdateInvoice(invoiceId, req.body, req.authUser);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.put('/api/invoices/:nomor_invoice', async (req, res, next) => {
  try {
    const invoiceId = decodeURIComponent(req.params.nomor_invoice);
    const updated = await handleUpdateInvoice(invoiceId, req.body, req.authUser);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

async function handleDeleteInvoice(invoiceId, username) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM invoices WHERE nomor_invoice = $1`, [invoiceId]);
    await insertActivityLog(client, username, 'DELETE', 'invoices', invoiceId);
  });
}

app.delete('/api/invoices', async (req, res, next) => {
  try {
    const invoiceId = String(req.query.nomor_invoice || '').trim();
    const username = String(req.query.username || req.authUser.user);
    if (!invoiceId) return res.status(400).json({ error: 'nomor_invoice wajib diisi.' });
    await handleDeleteInvoice(invoiceId, username);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/invoices/:nomor_invoice', async (req, res, next) => {
  try {
    const invoiceId = decodeURIComponent(req.params.nomor_invoice);
    const username = String(req.query.username || req.authUser.user);
    await handleDeleteInvoice(invoiceId, username);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Ledger Entries ---
app.get('/api/ledger_entries', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar, timestamp
       FROM ledger_entries ORDER BY timestamp DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/ledger_entries/:id/proof', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT bukti_bayar FROM ledger_entries WHERE id = $1 LIMIT 1`, [req.params.id]);
    res.json({ bukti_bayar: rows[0]?.bukti_bayar || null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/ledger_entries', async (req, res, next) => {
  try {
    const entry = req.body?.entry || req.body || {};
    const username = req.body?.username || req.authUser.user;

    const created = await withTransaction(async (client) => {
      const ledgerCols = await getTableColumns('ledger_entries', client);
      const hasBukti = ledgerCols.has('bukti_bayar');

      let rows;
      if (hasBukti) {
        ({ rows } = await client.query(
          `INSERT INTO ledger_entries (customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar, bukti_bayar)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar, timestamp`,
          [
            entry.customer_id,
            entry.tanggal,
            entry.keterangan || '',
            Number(entry.debit) || 0,
            Number(entry.credit) || 0,
            Number(entry.balance) || 0,
            entry.metode_bayar || null,
            entry.bukti_bayar || null,
          ]
        ));
      } else {
        ({ rows } = await client.query(
          `INSERT INTO ledger_entries (customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar, timestamp`,
          [
            entry.customer_id,
            entry.tanggal,
            entry.keterangan || '',
            Number(entry.debit) || 0,
            Number(entry.credit) || 0,
            Number(entry.balance) || 0,
            entry.metode_bayar || null,
          ]
        ));
      }

      await insertActivityLog(client, username, 'CREATE', 'ledger_entries', rows[0].id, {
        amount: entry.credit || entry.debit,
      });
      return rows[0];
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.put('/api/ledger_entries/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const entry = req.body?.entry || req.body || {};
    const { rows } = await query(
      `UPDATE ledger_entries
       SET customer_id = $1, tanggal = $2, keterangan = $3, debit = $4, credit = $5, balance = $6, metode_bayar = $7
       WHERE id = $8 RETURNING id, customer_id, tanggal, keterangan, debit, credit, balance, metode_bayar, timestamp`,
      [
        entry.customer_id,
        entry.tanggal,
        entry.keterangan || '',
        Number(entry.debit) || 0,
        Number(entry.credit) || 0,
        Number(entry.balance) || 0,
        entry.metode_bayar || null,
        id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Transaksi buku besar tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/ledger_entries/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = String(req.query.username || req.authUser.user);
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM ledger_entries WHERE id = $1 RETURNING id`, [id]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE', 'ledger_entries', id);
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Transaksi buku besar tidak ditemukan.' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Expenses ---
app.get('/api/expenses', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tanggal, kategori, jumlah, description, created_at FROM expenses ORDER BY tanggal DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/expenses/:id/proof', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT proof_image_url FROM expenses WHERE id = $1 LIMIT 1`, [req.params.id]);
    res.json({ proof_image_url: rows[0]?.proof_image_url || null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/expenses', async (req, res, next) => {
  try {
    const batch = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const username = req.body?.username || req.authUser.user;

    const created = await withTransaction(async (client) => {
      const inserted = [];
      for (const item of batch) {
        const tanggal =
          item.tanggal ||
          (item.date ? new Date(item.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
        const kategori = item.kategori ?? item.category ?? '';
        const jumlah = Number(item.jumlah ?? item.amount ?? 0);
        const description = item.description ?? '';
        const proofImageUrl = item.proof_image_url ?? item.proofImage ?? null;

        const { rows } = await client.query(
          `INSERT INTO expenses (tanggal, kategori, jumlah, description, proof_image_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, tanggal, kategori, jumlah, description, created_at`,
          [tanggal, kategori, jumlah, description, proofImageUrl]
        );
        inserted.push(rows[0]);
        await insertActivityLog(client, username, 'CREATE', 'expenses', rows[0].id, {
          category: kategori,
          amount: jumlah,
        });
      }
      return inserted;
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.put('/api/expenses/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const item = req.body || {};
    const tanggal =
      item.tanggal || (item.date ? new Date(item.date).toISOString().slice(0, 10) : undefined);
    const { rows } = await query(
      `UPDATE expenses
       SET tanggal = COALESCE($1, tanggal), kategori = $2, jumlah = $3, description = $4
       WHERE id = $5 RETURNING id, tanggal, kategori, jumlah, description, created_at`,
      [tanggal || null, item.kategori ?? item.category ?? '', Number(item.jumlah ?? item.amount ?? 0), item.description ?? '', id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Data pengeluaran tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/expenses/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = String(req.query.username || req.authUser.user);
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM expenses WHERE id = $1 RETURNING id`, [id]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE', 'expenses', id);
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Data pengeluaran tidak ditemukan.' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Salaries ---
app.get('/api/salaries', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, tanggal, nama_karyawan, gaji_harian, hari_kerja, kasbon, total_gaji, catatan, created_at
       FROM salaries ORDER BY tanggal DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/salaries', async (req, res, next) => {
  try {
    const batch = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const username = req.body?.username || req.authUser.user;

    const created = await withTransaction(async (client) => {
      const inserted = [];
      for (const s of batch) {
        const tanggal =
          s.tanggal || (s.date ? new Date(s.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
        const { rows } = await client.query(
          `INSERT INTO salaries (tanggal, nama_karyawan, gaji_harian, hari_kerja, kasbon, total_gaji, catatan)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            tanggal,
            s.nama_karyawan ?? s.employeeName ?? '',
            Number(s.gaji_harian ?? s.dailyRate ?? 0),
            Number(s.hari_kerja ?? s.daysWorked ?? 0),
            Number(s.kasbon ?? s.cashBon ?? 0),
            Number(s.total_gaji ?? s.totalSalary ?? 0),
            s.catatan ?? s.notes ?? '',
          ]
        );
        inserted.push(rows[0]);
      }
      await insertActivityLog(client, username, 'CREATE', 'salaries', 'batch', { count: batch.length });
      return inserted;
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.put('/api/salaries/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const s = req.body || {};
    const { rows } = await query(
      `UPDATE salaries
       SET tanggal = $1, nama_karyawan = $2, gaji_harian = $3, hari_kerja = $4, kasbon = $5, total_gaji = $6, catatan = $7
       WHERE id = $8 RETURNING *`,
      [
        s.tanggal,
        s.nama_karyawan ?? s.employeeName ?? '',
        Number(s.gaji_harian ?? s.dailyRate ?? 0),
        Number(s.hari_kerja ?? s.daysWorked ?? 0),
        Number(s.kasbon ?? s.cashBon ?? 0),
        Number(s.total_gaji ?? s.totalSalary ?? 0),
        s.catatan ?? s.notes ?? '',
        id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Data gaji tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/salaries/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = String(req.query.username || req.authUser.user);
    const deleted = await withTransaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM salaries WHERE id = $1 RETURNING id`, [id]);
      if (rows.length === 0) return null;
      await insertActivityLog(client, username, 'DELETE', 'salaries', id);
      return rows[0];
    });
    if (!deleted) return res.status(404).json({ error: 'Data gaji tidak ditemukan.' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Early Stock ---
app.get('/api/early_stock', async (_req, res, next) => {
  try {
    const { rows } = await query(`SELECT tanggal, item_name, ending_stock FROM early_stock ORDER BY tanggal DESC`);
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    next(err);
  }
});

app.post('/api/early_stock', async (req, res, next) => {
  try {
    const { tanggal, amount, ending_stock, username } = req.body || {};
    const actor = username || req.authUser.user;
    const val = Number(amount ?? ending_stock ?? 0);

    const saved = await withTransaction(async (client) => {
      await client.query(`DELETE FROM early_stock WHERE tanggal = $1`, [tanggal]);
      const { rows } = await client.query(
        `INSERT INTO early_stock (tanggal, item_name, ending_stock) VALUES ($1, 'TOTAL_SNAPSHOT', $2) RETURNING *`,
        [tanggal, val]
      );
      await insertActivityLog(client, actor, 'UPSERT_ENDING_INVENTORY', 'early_stock', tanggal, { amount: val });
      return rows[0];
    });

    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

app.put('/api/early_stock/:tanggal', async (req, res, next) => {
  try {
    const tanggal = req.params.tanggal;
    const val = Number(req.body?.amount ?? req.body?.ending_stock ?? 0);
    const { rows } = await query(
      `UPDATE early_stock SET ending_stock = $1 WHERE tanggal = $2 RETURNING *`,
      [val, tanggal]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Data saldo awal tidak ditemukan.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/early_stock/:tanggal', async (req, res, next) => {
  try {
    const tanggal = req.params.tanggal;
    const username = String(req.query.username || req.authUser.user);
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM early_stock WHERE tanggal = $1`, [tanggal]);
      await insertActivityLog(client, username, 'DELETE_ENDING_INVENTORY', 'early_stock', tanggal);
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Activity Logs ---
app.get('/api/activity_logs', async (req, res, next) => {
  try {
    const { startDate, endDate, action } = req.query;
    const conditions = [];
    const params = [];

    if (startDate) {
      params.push(`${startDate}T00:00:00Z`);
      conditions.push(`timestamp >= $${params.length}`);
    }
    if (endDate) {
      params.push(`${endDate}T23:59:59Z`);
      conditions.push(`timestamp <= $${params.length}`);
    }
    if (action && action !== 'ALL') {
      params.push(String(action));
      conditions.push(`action = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT * FROM activity_logs ${whereClause} ORDER BY timestamp DESC LIMIT 1000`,
      params
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    next(err);
  }
});

app.post('/api/activity_logs', async (req, res, next) => {
  try {
    const { username, action, target_table, target_id, details } = req.body || {};
    await insertActivityLog(pool, username || req.authUser.user, action, target_table, target_id, details);
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- System Cutoff ---
app.post('/api/system/cutoff', async (req, res, next) => {
  try {
    const { cutoffDateStr, cutoffDebts = {}, cutoffStocks = {}, username } = req.body || {};
    const actor = username || req.authUser.user;
    if (!cutoffDateStr) return res.status(400).json({ error: 'cutoffDateStr wajib diisi.' });

    const cutoffTimestamp = `${cutoffDateStr}T00:00:00.000Z`;
    const tablesWithTanggal = [
      'delivery_orders',
      'invoices',
      'expenses',
      'salaries',
      'ledger_entries',
      'trading_purchases',
      'stock_disposals',
    ];

    await withTransaction(async (client) => {
      for (const table of tablesWithTanggal) {
        await client.query(`DELETE FROM ${table} WHERE tanggal < $1`, [cutoffDateStr]);
      }
      await client.query(`DELETE FROM production_logs WHERE tanggal_produksi < $1`, [cutoffDateStr]);
      await client.query(`DELETE FROM stock_logs WHERE timestamp < $1`, [cutoffTimestamp]);

      for (const [customerId, balance] of Object.entries(cutoffDebts)) {
        if (Number(balance) > 0) {
          await client.query(
            `INSERT INTO ledger_entries (customer_id, tanggal, keterangan, debit, credit)
             VALUES ($1, $2, 'Saldo Awal Cutoff', $3, 0)`,
            [customerId, cutoffDateStr, Number(balance)]
          );
        }
      }

      for (const [itemName, qty] of Object.entries(cutoffStocks)) {
        if (Number(qty) !== 0) {
          await client.query(
            `INSERT INTO stock_logs (item_name, timestamp, tipe, stok_awal, perubahan, stok_akhir, keterangan)
             VALUES ($1, $2, 'CUTOFF', 0, $3, $3, 'Stok Awal Cutoff')`,
            [itemName, cutoffTimestamp, Number(qty)]
          );
        }
      }

      await insertActivityLog(client, actor, 'CUTOFF', 'system', 'all', { cutoff_date: cutoffDateStr });
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Global Error Handler ---
app.use((err, _req, res, _next) => {
  console.error('[Backend API Error]:', err);
  const mapped = translatePgError(err);
  res.status(mapped.status).json({ error: mapped.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  DPJ RPA Backend API berjalan di http://localhost:${PORT}`);
  console.log(`  Database target: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'dpj_rpa'}\n`);
});

import 'dotenv/config';
import pg from 'pg';

const { Pool, types } = pg;

// Keep PostgreSQL DATE (OID 1082) as 'YYYY-MM-DD' string without local timezone shift
types.setTypeParser(1082, (val) => val);
// Parse PostgreSQL NUMERIC / DECIMAL (OID 1700) into JS numbers
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// Parse PostgreSQL INT8 / BIGINT (OID 20) into JS numbers
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'dpj_rpa',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Pool Error]:', err.message);
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[PostgreSQL Rollback Error]:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

export function translatePgError(err) {
  if (!err) {
    return { status: 500, message: 'Terjadi kesalahan database yang tidak diketahui.' };
  }
  switch (err.code) {
    case '23505':
      return {
        status: 409,
        message: `Data duplikat sudah ada di database (${err.detail || err.constraint || 'unique constraint'}).`,
      };
    case '23503':
      return {
        status: 400,
        message: `Referensi data master tidak ditemukan (${err.detail || err.constraint || 'foreign key'}). Pastikan nama item, customer, atau kandang sudah terdaftar di data master.`,
      };
    case '23502':
      return {
        status: 400,
        message: `Kolom wajib "${err.column || ''}" tidak boleh kosong.`,
      };
    case '22P02':
      return {
        status: 400,
        message: 'Format data atau ID tidak valid.',
      };
    case '42P01':
      return {
        status: 500,
        message: 'Tabel database belum tersedia. Jalankan skrip SQL schema terlebih dahulu di pgAdmin.',
      };
    case '28P01':
      return {
        status: 500,
        message: 'Autentikasi PostgreSQL gagal. Periksa DB_USER dan DB_PASSWORD di backend/.env.',
      };
    case 'ECONNREFUSED':
      return {
        status: 503,
        message: 'Tidak dapat terhubung ke PostgreSQL. Pastikan layanan PostgreSQL berjalan di port 5432.',
      };
    default:
      if (err.statusCode) {
        return { status: err.statusCode, message: err.message };
      }
      return {
        status: 500,
        message: err.message || 'Kesalahan internal server database.',
      };
  }
}

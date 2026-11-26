import type { CachedTableName } from './idbCache';

export type MainViewId = 'production' | 'logistics' | 'finance' | 'reports' | 'database' | 'dataLogger';
export type StockSubView = 'main' | 'history' | 'trading' | 'disposal';
export type DatabaseSubTab = 'coops' | 'plates' | 'customers' | 'items' | 'backup';

export interface AppWindow {
  id: string;
  view: MainViewId;
  subTab?: string;
  stockSubView?: StockSubView;
  dbSubTab?: DatabaseSubTab;
}

export interface ModulePreset {
  key: string;
  category: 'Produksi' | 'Logistik' | 'Keuangan' | 'Laporan' | 'Sistem';
  label: string;
  view: MainViewId;
  subTab?: string;
}

export const MODULE_PRESETS: ModulePreset[] = [
  { key: 'production', category: 'Produksi', label: 'Input Produksi', view: 'production' },

  { key: 'logistics:stock', category: 'Logistik', label: 'Inventaris & Stok', view: 'logistics', subTab: 'stock' },
  { key: 'logistics:delivery_orders', category: 'Logistik', label: 'Surat Jalan', view: 'logistics', subTab: 'delivery_orders' },
  { key: 'logistics:daily_recap', category: 'Logistik', label: 'Daily Recap', view: 'logistics', subTab: 'daily_recap' },

  { key: 'finance:chicken_prices', category: 'Keuangan', label: 'Harga Kandang', view: 'finance', subTab: 'chicken_prices' },
  { key: 'finance:ledger', category: 'Keuangan', label: 'Buku Piutang (Ledger)', view: 'finance', subTab: 'ledger' },
  { key: 'finance:invoices_list', category: 'Keuangan', label: 'Daftar Invoice', view: 'finance', subTab: 'invoices_list' },
  { key: 'finance:expenses', category: 'Keuangan', label: 'Pengeluaran', view: 'finance', subTab: 'expenses' },
  { key: 'finance:salaries', category: 'Keuangan', label: 'Gaji Karyawan', view: 'finance', subTab: 'salaries' },
  { key: 'finance:stock_value', category: 'Keuangan', label: 'Nilai Stok', view: 'finance', subTab: 'stock_value' },
  { key: 'finance:profit_loss', category: 'Keuangan', label: 'Laba Rugi (P&L)', view: 'finance', subTab: 'profit_loss' },
  { key: 'finance:belanja_lb', category: 'Keuangan', label: 'Belanja LB', view: 'finance', subTab: 'belanja_lb' },
  { key: 'finance:hpp', category: 'Keuangan', label: 'HPP', view: 'finance', subTab: 'hpp' },

  { key: 'reports:dashboard', category: 'Laporan', label: 'Dashboard Ringkasan', view: 'reports', subTab: 'dashboard' },
  { key: 'reports:production', category: 'Laporan', label: 'Laporan Produksi', view: 'reports', subTab: 'production' },
  { key: 'reports:sales_history', category: 'Laporan', label: 'Riwayat Penjualan', view: 'reports', subTab: 'sales_history' },

  { key: 'database', category: 'Sistem', label: 'Basis Data', view: 'database' },
  { key: 'dataLogger', category: 'Sistem', label: 'Riwayat Aktivitas', view: 'dataLogger' },
];

export const getDefaultSubTab = (view: MainViewId): string | undefined => {
  switch (view) {
    case 'logistics':
      return 'stock';
    case 'finance':
      return 'chicken_prices';
    case 'reports':
      return 'dashboard';
    default:
      return undefined;
  }
};

export const getSubModulesForView = (view: MainViewId): ModulePreset[] => {
  return MODULE_PRESETS.filter((p) => p.view === view);
};

export const getWindowTitle = (win: AppWindow): string => {
  const sub = win.subTab || getDefaultSubTab(win.view);
  if (win.view === 'production') return 'Input Produksi';
  if (win.view === 'database') return 'Basis Data';
  if (win.view === 'dataLogger') return 'Riwayat Aktivitas';
  if (win.view === 'logistics') {
    if (sub === 'stock') {
      if (win.stockSubView === 'history') return 'Log Stok';
      if (win.stockSubView === 'trading') return 'Riwayat Trading';
      if (win.stockSubView === 'disposal') return 'Pemusnahan';
      return 'Inventaris & Stok';
    }
    if (sub === 'delivery_orders') return 'Surat Jalan';
    return 'Daily Recap';
  }
  if (win.view === 'finance') {
    const map: Record<string, string> = {
      ledger: 'Ledger',
      chicken_prices: 'Harga Kandang',
      invoices_list: 'Daftar Invoice',
      expenses: 'Pengeluaran',
      salaries: 'Gaji Karyawan',
      stock_value: 'Nilai Stok',
      profit_loss: 'Laba Rugi',
      belanja_lb: 'Belanja LB',
      hpp: 'HPP',
    };
    return map[sub || ''] || (sub || '').toUpperCase();
  }
  if (win.view === 'reports') {
    const map: Record<string, string> = {
      dashboard: 'Dashboard',
      production: 'Lap. Produksi',
      sales_history: 'Riwayat Penjualan',
    };
    return map[sub || 'dashboard'] || 'Laporan';
  }
  return win.view;
};

export const getTablesForWindow = (win: AppWindow): string[] => {
  const sub = win.subTab || getDefaultSubTab(win.view);

  switch (win.view) {
    case 'production':
      return ['master_coops', 'master_plates', 'master_items', 'production_logs'];

    case 'logistics':
      if (sub === 'stock') {
        if (win.stockSubView === 'history') {
          return ['stock_logs'];
        }
        if (win.stockSubView === 'trading') {
          return ['trading_purchases', 'master_items', 'current_stock'];
        }
        if (win.stockSubView === 'disposal') {
          return ['stock_disposals', 'master_items', 'current_stock'];
        }
        return ['master_items', 'current_stock', 'stock_logs'];
      }
      if (sub === 'delivery_orders') {
        return ['delivery_orders', 'invoices', 'ledger_entries', 'master_customers', 'master_items'];
      }
      // daily_recap
      return ['production_logs', 'delivery_orders', 'trading_purchases', 'stock_disposals', 'master_items', 'stock_logs'];

    case 'finance':
      switch (sub) {
        case 'ledger':
          return ['ledger_entries', 'invoices', 'delivery_orders', 'master_customers', 'master_items'];
        case 'chicken_prices':
          return ['production_logs'];
        case 'invoices_list':
          return ['invoices', 'ledger_entries', 'delivery_orders', 'master_customers', 'master_items'];
        case 'expenses':
          return ['expenses'];
        case 'salaries':
          return ['salaries'];
        case 'stock_value':
          return ['stock_logs', 'invoices', 'master_items', 'current_stock', 'production_logs', 'delivery_orders', 'master_customers', 'ledger_entries'];
        case 'profit_loss':
          return [
            'invoices', 'production_logs', 'expenses', 'salaries', 'stock_logs',
            'trading_purchases', 'stock_disposals', 'current_stock', 'master_items',
            'ledger_entries', 'early_stock', 'master_customers', 'delivery_orders',
          ];
        case 'belanja_lb':
          return ['production_logs'];
        case 'hpp':
          return ['production_logs', 'expenses', 'invoices', 'master_items', 'master_customers', 'ledger_entries', 'delivery_orders'];
        default:
          return ['production_logs'];
      }

    case 'reports':
      if (sub === 'production') {
        return ['production_logs', 'master_coops', 'master_plates', 'master_items'];
      }
      if (sub === 'sales_history') {
        return ['delivery_orders', 'invoices', 'master_customers', 'ledger_entries', 'master_items'];
      }
      // dashboard
      return [
        'production_logs', 'delivery_orders', 'invoices', 'expenses', 'salaries',
        'stock_logs', 'current_stock', 'master_items', 'ledger_entries',
        'trading_purchases', 'stock_disposals', 'early_stock', 'master_customers',
      ];

    case 'database':
      if (win.dbSubTab === 'customers') {
        return ['master_coops', 'master_plates', 'master_customers', 'master_items', 'invoices', 'ledger_entries', 'delivery_orders'];
      }
      return ['master_coops', 'master_plates', 'master_customers', 'master_items'];

    case 'dataLogger':
    default:
      return [];
  }
};

export const MUTABLE_LARGE_TABLES: readonly CachedTableName[] = [
  'invoices',
  'delivery_orders',
  'ledger_entries',
  'production_logs',
];

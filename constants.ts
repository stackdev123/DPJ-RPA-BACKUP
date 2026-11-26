
export const CHICKEN_PARTS = [
  'KRK',
  'SAYAP A',
  'SAYAP R',
  'PALA',
  'CEKER',
  'HATI AMPELA',
  'P.PENTUNG',
  'P.UTUH',
  'P.ATAS',
  'BLD',
  'BLD.K',
  'BLP LEBAR',
  'BLP ATAS',
  'BLP.K LEBAR',
  'BLPK ATAS',
  'KULIT',
  'USUS',
  'TLP I',
  'TLP L',
  'KARKAS',
  'AYAM PC',
  'AYAM TB',
  'TUNGGIR'
];

export const sortChickenParts = (a: string, b: string) => {
  const indexA = CHICKEN_PARTS.indexOf(a);
  const indexB = CHICKEN_PARTS.indexOf(b);
  if (indexA !== -1 && indexB !== -1) return indexA - indexB;
  if (indexA !== -1) return -1;
  if (indexB !== -1) return 1;
  return a.localeCompare(b);
};

export const INITIAL_STOCK_OCT_18: { [key: string]: number } = {
    'KRK': 0,
    'SAYAP A': 0,
    'SAYAP R': 85,
    'PALA': 0,
    'CEKER': 0,
    'HATI AMPELA': 2799,
    'P.PENTUNG': 5,
    'P.UTUH': 0,
    'P.ATAS': 0,
    'BLD': 410,
    'BLD.K': 0,
    'BLP LEBAR': 0,
    'BLP ATAS': 25,
    'BLP.K LEBAR': 0,
    'BLPK ATAS': 0,
    'KULIT': 115,
    'USUS': 100,
    'TLP I': 725,
    'TLP L': 180,
    'KARKAS': 0.23,
    'AYAM PC': 0,
    'AYAM TB': 0,
    'TUNGGIR': 3.75
};

export const INITIAL_VALUATION_OCT_18 = 12720313;

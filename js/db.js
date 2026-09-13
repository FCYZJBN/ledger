// 数据层：IndexedDB 封装（全部 Promise 化）

const DB_NAME = 'ledger-db';
const DB_VERSION = 1;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('type', 'type');
        s.createIndex('categoryId', 'categoryId');
        s.createIndex('accountId', 'accountId');
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function getAll(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).getAll();
  return reqToPromise(req);
}

export async function get(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).get(key);
  return reqToPromise(req);
}

export async function put(storeName, value) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await txDone(tx);
}

export async function putMany(storeName, values) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  values.forEach((v) => store.put(v));
  await txDone(tx);
}

export async function remove(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await txDone(tx);
}

export async function clear(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

// 原子化导入：在单个事务里清空并写入全部数据，避免中途失败导致半导入状态
export async function importAll({ categories: cats, accounts: accts, transactions: txns, budget }) {
  const db = await openDB();
  const tx = db.transaction(['transactions', 'categories', 'accounts', 'settings'], 'readwrite');
  tx.objectStore('transactions').clear();
  tx.objectStore('categories').clear();
  tx.objectStore('accounts').clear();
  (cats || []).forEach((c) => tx.objectStore('categories').put(c));
  (accts || []).forEach((a) => tx.objectStore('accounts').put(a));
  (txns || []).forEach((t) => tx.objectStore('transactions').put(t));
  if (typeof budget === 'number') tx.objectStore('settings').put({ key: 'monthlyBudget', value: budget });
  else tx.objectStore('settings').delete('monthlyBudget');
  await txDone(tx);
}

// —— 领域封装 ——
export const txns = {
  all: () => getAll('transactions'),
  add: (t) => put('transactions', t),
  update: (t) => put('transactions', t),
  remove: (id) => remove('transactions', id),
  bulkAdd: (list) => putMany('transactions', list),
};

export const categories = {
  all: () => getAll('categories'),
  add: (c) => put('categories', c),
  update: (c) => put('categories', c),
  remove: (id) => remove('categories', id),
  bulkAdd: (list) => putMany('categories', list),
};

export const accounts = {
  all: () => getAll('accounts'),
  add: (a) => put('accounts', a),
  update: (a) => put('accounts', a),
  remove: (id) => remove('accounts', id),
  bulkAdd: (list) => putMany('accounts', list),
};

export const settings = {
  get: async (key, fallback) => {
    const row = await get('settings', key);
    return row ? row.value : fallback;
  },
  set: async (key, value) => put('settings', { key, value }),
};

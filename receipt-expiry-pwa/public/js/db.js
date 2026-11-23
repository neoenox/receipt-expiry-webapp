const DB_NAME = 'ReceiptExpiryDB';
const DB_VERSION = 6;
const STORE = {
  items: 'food_items',
  queue: 'analysisQueue',
  history: 'consumptionHistory',
  hints: 'expiryHints',

  shopping: 'shoppingList',
};

let dbPromise = null;

/** DB接続を一度だけ確立し、CRUD操作をPromiseで提供する。 */
export function initDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('このブラウザはIndexedDBに対応していません。'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const items = db.objectStoreNames.contains(STORE.items)
          ? request.transaction.objectStore(STORE.items)
          : db.createObjectStore(STORE.items, { keyPath: 'id' });
        if (!items.indexNames.contains('idx_expiryDate')) {
          items.createIndex('idx_expiryDate', 'expiryDate');
        }
        if (!items.indexNames.contains('idx_storage')) {
          items.createIndex('idx_storage', 'storage');
        }
        if (!items.indexNames.contains('idx_expiry_created')) {
          items.createIndex('idx_expiry_created', ['expiryDate', 'createdAt']);
        }
        if (!db.objectStoreNames.contains(STORE.queue)) {
          db.createObjectStore(STORE.queue, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.history)) {
          const history = db.createObjectStore(STORE.history, { keyPath: 'id' });
          history.createIndex('idx_consumedAt', 'consumedAt');
        }
        if (!db.objectStoreNames.contains(STORE.hints)) {
          db.createObjectStore(STORE.hints, { keyPath: 'name' });
        }

        if (!db.objectStoreNames.contains(STORE.shopping)) {
          db.createObjectStore(STORE.shopping, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('データベースを開けませんでした。'));
      };
    });
  }
  return dbPromise;
}

/** トランザクション完了を待ってresolveする。setResultは読み取り結果の受け渡しに使う。 */
function withStore(mode, callback, storeName = STORE.items) {
  return initDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('データベース処理に失敗しました。'));
    tx.onabort = () => reject(tx.error || new Error('データベース処理が中止されました。'));
    try {
      callback(store, (value) => { result = value; });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  }));
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ---------- 在庫 ---------- */

export function addItemsBulk(items) {
  const now = Date.now();
  return withStore('readwrite', (store) => {
    for (const [index, item] of items.entries()) {
      store.put({ ...item, id: newId(), createdAt: now + index });
    }
  });
}

export function getAllItemsSorted() {
  return withStore('readonly', (store, setResult) => {
    const request = store.index('idx_expiry_created').getAll();
    request.onsuccess = () => { setResult(request.result); };
  });
}

export function getAllItems() {
  return withStore('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => { setResult(request.result || []); };
  });
}

export function importItems(items) {
  return withStore('readwrite', (store) => {
    for (const item of items) store.put(item);
  });
}

export function updateItem(item) {
  return withStore('readwrite', (store) => { store.put(item); });
}

export function deleteItem(id) {
  return withStore('readwrite', (store) => { store.delete(id); });
}

/* ---------- オフライン解析キュー ---------- */

export function enqueueAnalysis(job) {
  return withStore('readwrite', (store) => { store.put(job); }, STORE.queue);
}

export function listQueuedAnalyses() {
  return withStore('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => { setResult(request.result || []); };
  }, STORE.queue);
}

export function updateQueuedAnalysis(job) {
  return withStore('readwrite', (store) => { store.put(job); }, STORE.queue);
}

export function deleteQueuedAnalysis(id) {
  return withStore('readwrite', (store) => { store.delete(id); }, STORE.queue);
}

/* ---------- 消費・廃棄履歴 ---------- */

export function addConsumption(entry) {
  return withStore('readwrite', (store) => { store.put(entry); }, STORE.history);
}

export function listConsumption() {
  return withStore('readonly', (store, setResult) => {
    const request = store.index('idx_consumedAt').getAll();
    request.onsuccess = () => { setResult(request.result || []); };
  }, STORE.history);
}

export function importConsumption(entries) {
  return withStore('readwrite', (store) => {
    for (const entry of entries) store.put(entry);
  }, STORE.history);
}


/* ---------- 賞味期限の学習 ---------- */

export function saveExpiryHint(hint) {
  return withStore('readwrite', (store) => { store.put(hint); }, STORE.hints);
}

export function listExpiryHints() {
  return withStore('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => { setResult(request.result || []); };
  }, STORE.hints);
}

export function importExpiryHints(hints) {
  return withStore('readwrite', (store) => {
    for (const hint of hints) store.put(hint);
  }, STORE.hints);
}


/** 全ストアを1トランザクションで空にする（途中終了で中途半端な状態にならない）。 */
export function clearAllData() {
  const stores = Object.values(STORE);
  return initDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('データベース処理に失敗しました。'));
    tx.onabort = () => reject(tx.error || new Error('データベース処理が中止されました。'));
    try {
      for (const name of stores) tx.objectStore(name).clear();
    } catch (error) {
      tx.abort();
      reject(error);
    }
  }));
}


export function addShoppingItems(items) {
  return withStore('readwrite', (store) => {
    for (const item of items) store.put(item);
  }, STORE.shopping);
}

export function listShoppingItems() {
  return withStore('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => { setResult(request.result || []); };
  }, STORE.shopping);
}

export function deleteShoppingItem(id) {
  return withStore('readwrite', (store) => { store.delete(id); }, STORE.shopping);
}

export function clearShoppingItems() {
  return withStore('readwrite', (store) => { store.clear(); }, STORE.shopping);
}

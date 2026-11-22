const DB_NAME = 'ReceiptExpiryDB';
const DB_VERSION = 2;
const STORE_NAME = 'food_items';

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
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        if (!store.indexNames.contains('idx_expiryDate')) {
          store.createIndex('idx_expiryDate', 'expiryDate');
        }
        if (!store.indexNames.contains('idx_storage')) {
          store.createIndex('idx_storage', 'storage');
        }
        if (!store.indexNames.contains('idx_expiry_created')) {
          store.createIndex('idx_expiry_created', ['expiryDate', 'createdAt']);
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
function withStore(mode, callback) {
  return initDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
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

/** 配列の全アイテムにIDと登録日時を付与し、1トランザクションで保存する。 */
export function addItemsBulk(items) {
  const now = Date.now();
  return withStore('readwrite', (store) => {
    for (const [index, item] of items.entries()) {
      store.put({
        ...item,
        id: newId(),
        createdAt: now + index,
      });
    }
  });
}

/** 賞味期限→登録日時の順で全件返す。 */
export function getAllItemsSorted() {
  return withStore('readonly', (store, setResult) => {
    const request = store.index('idx_expiry_created').getAll();
    request.onsuccess = () => {
      setResult(request.result);
    };
  });
}

/** バックアップ書き出し用に全件をそのまま返す。 */
export function getAllItems() {
  return withStore('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => {
      setResult(request.result || []);
    };
  });
}

/** IDが同じレコードは渡された内容で上書きし、それ以外は残す。 */
export function importItems(items) {
  return withStore('readwrite', (store) => {
    for (const item of items) {
      store.put(item);
    }
  });
}


export function updateItem(item) {
  return withStore('readwrite', (store) => {
    store.put(item);
  });
}

export function deleteItem(id) {
  return withStore('readwrite', (store) => {
    store.delete(id);
  });
}

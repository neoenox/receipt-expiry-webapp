import { initDB, addItemsBulk, getAllItems, getAllItemsSorted, importItems, updateItem, deleteItem, enqueueAnalysis, listQueuedAnalyses, updateQueuedAnalysis, deleteQueuedAnalysis, addConsumption, listConsumption, importConsumption, saveExpiryHint, listExpiryHints, importExpiryHints } from './db.js';
import { processReceiptImage } from './imageProcessor.js';
import { analyzeReceipt, isValidDate } from './apiClient.js';
import { serializeBackup, parseBackup } from './backup.js';
import { createQueuedAnalysis, nextAttempt, shouldDiscard } from './queue.js';
import { createConsumption, summarizeHistory } from './history.js';
import { createExpiryHint, buildHintMap, normalizeFoodName } from './learning.js';
import { filterAndSortItems } from './inventory.js';

const STORAGE_LABELS = { fridge: '冷蔵', freezer: '冷凍', pantry: '常温' };
const BYOK_STORAGE_KEY = 'receipt-expiry-gemini-key';
const NOTIFY_STORAGE_KEY = 'receipt-expiry-notify';

const byId = (id) => document.getElementById(id);
const ui = {
  tabs: byId('storage-tabs'),
  list: byId('item-list'),
  itemCount: byId('item-count'),

  searchInput: byId('search-input'),
  sortSelect: byId('sort-select'),
  emptyState: byId('empty-state'),
  emptyTitle: byId('empty-title'),
  emptyDetail: byId('empty-detail'),
  sourceModal: byId('source-modal'),
  loading: byId('loading-overlay'),
  resultModal: byId('result-modal'),
  resultItems: byId('result-items'),
  resultSummary: byId('result-summary'),
  resultSave: byId('result-save'),
  editModal: byId('edit-modal'),
  editForm: byId('edit-form'),
  editTitle: byId('edit-title'),
  editError: byId('edit-error'),
  editDelete: byId('edit-delete'),
  settingsModal: byId('settings-modal'),
  installBtn: byId('install-btn'),
  apiKeyInput: byId('api-key-input'),
  apiKeyStatus: byId('api-key-status'),

  exportBackupBtn: byId('export-backup-btn'),
  importBackupBtn: byId('import-backup-btn'),
  backupInput: byId('backup-input'),
  backupStatus: byId('backup-status'),

  queueStatus: byId('queue-status'),
  retryQueueBtn: byId('retry-queue-btn'),
  historySummary: byId('history-summary'),

  notifyEnableBtn: byId('notify-enable-btn'),
  notifyDisableBtn: byId('notify-disable-btn'),
  notifyStatus: byId('notify-status'),
  consumeModal: byId('consume-modal'),
  consumeItem: byId('consume-item'),
  cameraInput: byId('camera-input'),
  galleryInput: byId('gallery-input'),
  itemTemplate: byId('item-card-template'),
  rowTemplate: byId('result-row-template'),
  toast: byId('toast'),
};

const state = {
  items: [],
  filter: 'all',

  search: '',
  sort: 'expiry',
  editingId: null,
  resultPurchaseDate: null,
  deferredInstallPrompt: null,
  toastTimer: null,
  modalStack: [],
  focusBeforeModal: null,
  savingEdit: false,
  didReloadForUpdate: false,

  processingQueue: false,
  consumeTarget: null,
  expiryHints: new Map(),

  syncingPush: false,
};

/* ---------- 日付・ステータス ---------- */

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayISO() {
  return formatDate(new Date());
}

function defaultExpiryISO() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return formatDate(date);
}

function parseLocalDate(value) {
  if (!isValidDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function calcRemainingDays(expiryDateStr) {
  const expiry = parseLocalDate(expiryDateStr);
  if (!expiry) return NaN;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
}

function statusFor(days) {
  if (days < 0) return { className: 'badge-expired', label: `期限切れ (${Math.abs(days)}日超過)` };
  if (days === 0) return { className: 'badge-warning', label: '今日まで' };
  if (days <= 3) return { className: 'badge-warning', label: `あと${days}日` };
  return { className: 'badge-safe', label: `あと${days}日` };
}

/* ---------- 共通UI ---------- */

function openModal(element) {
  if (state.modalStack.includes(element)) return;
  state.focusBeforeModal = document.activeElement;
  state.modalStack.push(element);
  element.classList.remove('hidden');
  element.querySelector('button, input, select, textarea')?.focus();
}

function closeModal(element) {
  element.classList.add('hidden');
  state.modalStack = state.modalStack.filter((item) => item !== element);
  const top = state.modalStack[state.modalStack.length - 1];
  if (top) {
    top.querySelector('button, input, select, textarea')?.focus();
  } else if (state.focusBeforeModal instanceof HTMLElement) {
    state.focusBeforeModal.focus();
    state.focusBeforeModal = null;
  }
}

function showToast(message, duration = 3400) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.remove('hidden');
  state.toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), duration);
}

function showLoading(visible) {
  ui.loading.classList.toggle('hidden', !visible);
}

/* ---------- 在庫一覧 ---------- */

async function refreshItems() {
  state.items = await getAllItemsSorted();
  renderList();

  void syncPushReminder();
}

function renderList() {
  const visible = filterAndSortItems(state.items, {
    filter: state.filter,
    search: state.search,
    sort: state.sort,
  });

  ui.list.replaceChildren();
  for (const item of visible) {
    const card = ui.itemTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector('.item-name').textContent = item.name;
    card.querySelector('.item-storage').textContent = STORAGE_LABELS[item.storage] || '';
    card.querySelector('.item-quantity').textContent = item.quantity || '';

    const days = calcRemainingDays(item.expiryDate);
    const badge = card.querySelector('.badge');
    if (Number.isNaN(days)) {
      badge.className = 'badge badge-warning';
      badge.textContent = '期限不明';
    } else {
      const status = statusFor(days);
      badge.className = `badge ${status.className}`;
      badge.textContent = status.label;
    }

    const expiry = card.querySelector('.item-expiry');
    expiry.textContent = item.expiryDate;
    expiry.dateTime = item.expiryDate;
    card.querySelector('.item-card-main').addEventListener('click', () => openEditModal(item));
    ui.list.append(card);
  }

  ui.itemCount.textContent = `${visible.length}件`;
  ui.emptyState.classList.toggle('hidden', visible.length > 0);
  if (visible.length === 0) {
    const noItems = state.items.length === 0;
    ui.emptyTitle.textContent = noItems ? 'まだ食材がありません' : 'この保存場所には食材がありません';
    ui.emptyDetail.textContent = noItems
      ? 'レシートを撮影するか、＋ボタンから食材を追加してください。'
      : '別の保存場所のタブを選択してください。';
  }
}

/* ---------- 撮影・解析 ---------- */

function openSourceModal() {
  openModal(ui.sourceModal);
}

function handleFileSelected(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (file) void analyzeFile(file);
}

async function submitAnalysis(payload) {
  const result = await analyzeReceipt({ ...payload, customApiKey: getApiKey() || undefined });
  if (result.items.length === 0) {
    showToast('食材が見つかりませんでした。別の画像をお試しください。');
    return;
  }
  openResultModal(result);
}

async function analyzeFile(file) {
  closeModal(ui.sourceModal);
  showLoading(true);
  try {
    const { base64, mimeType } = await processReceiptImage(file);
    const payload = { imageBase64: base64, mimeType, clientDate: todayISO() };
    if (!navigator.onLine) {
      await enqueueAnalysis(createQueuedAnalysis(payload));
      await refreshQueueStatus();
      showToast('オフラインです。接続が戻ったら自動で解析します。');
      return;
    }
    await submitAnalysis(payload);
  } catch (error) {
    showToast(error.message || '解析に失敗しました。');
  } finally {
    showLoading(false);
  }
}

async function refreshQueueStatus() {
  const jobs = await listQueuedAnalyses();
  ui.queueStatus.textContent = jobs.length ? `未送信の解析: ${jobs.length}件` : '未送信の解析はありません。';
  ui.retryQueueBtn.disabled = jobs.length === 0;
}

async function processQueue() {
  if (state.processingQueue) return;
  state.processingQueue = true;
  try {
    const jobs = await listQueuedAnalyses();
    for (const job of jobs) {
      try {
        await submitAnalysis({
          imageBase64: job.imageBase64,
          mimeType: job.mimeType,
          clientDate: job.clientDate,
        });
        await deleteQueuedAnalysis(job.id);
      } catch (error) {
        const attempted = nextAttempt(job);
        if (shouldDiscard(attempted)) {
          await deleteQueuedAnalysis(job.id);
          showToast('解析できなかったレシートを削除しました。');
        } else {
          await updateQueuedAnalysis(attempted);
          showToast(`再試行できませんでした: ${error.message || '不明なエラー'}`);
        }
        break;
      }
    }
    await refreshQueueStatus();
  } catch (error) {
    console.error('[queue]', error);
  } finally {
    state.processingQueue = false;
  }
}

/* ---------- 解析結果の確認・一括登録 ---------- */

function createResultRow(item = {}) {
  const row = ui.rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.field-name').value = item.name || '';
  row.querySelector('.field-storage').value = item.storage || 'fridge';
  const hint = state.expiryHints.get(normalizeFoodName(item.name || ''));
  row.querySelector('.field-expiry').value = item.expiryDate || hint || defaultExpiryISO();
  row.querySelector('.field-quantity').value = item.quantity || '';
  return row;
}

function openResultModal(result) {
  state.resultPurchaseDate = result.purchaseDate;
  ui.resultItems.replaceChildren(...result.items.map((item) => createResultRow(item)));
  const dateText = result.purchaseDate ? `購入日: ${result.purchaseDate} ／ ` : '';
  ui.resultSummary.textContent = `${dateText}${result.items.length}件の食材が見つかりました。内容を確認・修正してください。`;
  openModal(ui.resultModal);
}

async function saveResult() {
  const rows = Array.from(ui.resultItems.querySelectorAll('.result-row'));
  const items = [];
  for (const [index, row] of rows.entries()) {
    const name = row.querySelector('.field-name').value.trim();
    const expiryDate = row.querySelector('.field-expiry').value;
    if (!name || !isValidDate(expiryDate)) {
      showToast(`${index + 1}行目の食材名と賞味期限を入力してください。`);
      return;
    }
    items.push({
      name,
      storage: row.querySelector('.field-storage').value,
      expiryDate,
      quantity: row.querySelector('.field-quantity').value.trim(),
      purchaseDate: state.resultPurchaseDate || todayISO(),
    });
  }
  if (items.length === 0) {
    showToast('登録する食材がありません。');
    return;
  }

  ui.resultSave.disabled = true;
  try {
    await addItemsBulk(items);
    closeModal(ui.resultModal);
    await refreshItems();
    showToast(`${items.length}件の食材を登録しました。`);
  } catch (error) {
    showToast(error.message || '保存に失敗しました。');
  } finally {
    ui.resultSave.disabled = false;
  }
}

/* ---------- 個別編集・手動追加 ---------- */

function openEditModal(item = null) {
  state.editingId = item?.id || null;
  ui.editTitle.textContent = item ? '食材を編集' : '食材を手動追加';
  byId('edit-name').value = item?.name || '';
  byId('edit-storage').value = item?.storage || 'fridge';
  byId('edit-expiry').value = item?.expiryDate || defaultExpiryISO();
  byId('edit-quantity').value = item?.quantity || '';
  ui.editDelete.classList.toggle('hidden', !item);
  ui.editError.classList.add('hidden');
  openModal(ui.editModal);
  byId('edit-name').focus();
}

async function submitEdit(event) {
  event.preventDefault();
  if (state.savingEdit) return;
  state.savingEdit = true;
  const submitButton = ui.editForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const name = byId('edit-name').value.trim();
    const expiryDate = byId('edit-expiry').value;
    if (!name || !isValidDate(expiryDate)) {
      ui.editError.textContent = '食材名と賞味期限を入力してください。';
      ui.editError.classList.remove('hidden');
      return;
    }

    const fields = {
      name,
      storage: byId('edit-storage').value,
      expiryDate,
      quantity: byId('edit-quantity').value.trim(),
    };
    const wasEditing = Boolean(state.editingId);
    if (wasEditing) {
      const original = state.items.find((item) => item.id === state.editingId);
      if (!original) throw new Error('編集対象が見つかりません。');
      await updateItem({ ...original, ...fields });
      await saveExpiryHint(createExpiryHint(fields.name, fields.expiryDate));
      state.expiryHints.set(normalizeFoodName(fields.name), fields.expiryDate);
    } else {
      await addItemsBulk([{ ...fields, purchaseDate: todayISO() }]);
    }
    closeModal(ui.editModal);
    await refreshItems();
    showToast(wasEditing ? '食材を更新しました。' : '食材を追加しました。');
  } catch (error) {
    showToast(error.message || '保存に失敗しました。');
  } finally {
    state.savingEdit = false;
    submitButton.disabled = false;
  }
}

function removeEditedItem() {
  if (!state.editingId) return;
  const item = state.items.find((entry) => entry.id === state.editingId);
  if (!item) return;
  state.consumeTarget = item;
  ui.consumeItem.textContent = `${item.name}（${item.expiryDate}）`;
  openModal(ui.consumeModal);
}

async function finishConsume(reason) {
  const item = state.consumeTarget;
  if (!item) return;
  try {
    await addConsumption(createConsumption(item, reason));
    await deleteItem(item.id);
    state.consumeTarget = null;
    closeModal(ui.consumeModal);
    closeModal(ui.editModal);
    await refreshItems();
    await refreshHistorySummary();
    showToast(reason === 'eaten' ? '食べたとして記録しました。' : '捨てたとして記録しました。');
  } catch (error) {
    showToast(error.message || '記録に失敗しました。');
  }
}

async function refreshHistorySummary() {
  const entries = await listConsumption();
  const summary = summarizeHistory(entries);
  ui.historySummary.textContent = `今月: 食べた ${summary.eaten}件 / 捨てた ${summary.discarded}件（合計 ${summary.total}件）`;
}

function isNotifyEnabled() {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function refreshNotifyStatus() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    ui.notifyStatus.textContent = 'このブラウザはプッシュ通知に対応していません。';
    return;
  }
  ui.notifyStatus.textContent = isNotifyEnabled()
    ? `通知を有効にしています（${Notification.permission}）。`
    : '通知は無効です。';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function enableNotifications() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      ui.notifyStatus.textContent = 'このブラウザはプッシュ通知に対応していません。';
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      ui.notifyStatus.textContent = '通知が許可されませんでした。ブラウザ設定で許可してください。';
      return;
    }
    const config = await fetch('/api/push/config').then((response) => response.json());
    if (!config.publicKey) throw new Error('通知の設定を取得できませんでした。');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    localStorage.setItem(NOTIFY_STORAGE_KEY, '1');
    await syncPushReminder();
    refreshNotifyStatus();
    showToast('賞味期限の通知を有効にしました。');
  } catch (error) {
    ui.notifyStatus.textContent = error.message || '通知を有効にできませんでした。';
    showToast('通知を有効にできませんでした。');
  }
}

async function disableNotifications() {
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
    }
    localStorage.removeItem(NOTIFY_STORAGE_KEY);
    refreshNotifyStatus();
    showToast('通知を無効にしました。');
  } catch (error) {
    showToast(error.message || '通知を無効にできませんでした。');
  }
}

async function syncPushReminder() {
  if (state.syncingPush || !isNotifyEnabled()) return;
  state.syncingPush = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const dates = state.items
      .map((item) => item.expiryDate)
      .filter((date) => isValidDate(date))
      .sort();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), nextExpiry: dates[0] || null }),
    });
  } catch {
    // 通知の同期失敗は在庫操作を止めない。
  } finally {
    state.syncingPush = false;
  }
}

/* ---------- 設定・BYOK・PWA ---------- */

function getApiKey() {
  try {
    return localStorage.getItem(BYOK_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function refreshApiKeyStatus() {
  ui.apiKeyInput.value = getApiKey();
  ui.apiKeyStatus.textContent = getApiKey()
    ? 'この端末にAPIキーが保存されています（解析時に自動で使用されます）。'
    : '未設定の場合は、アプリ側の共通キーで解析します。';
}

function openSettings() {
  refreshApiKeyStatus();
  ui.backupStatus.textContent = '';
  refreshNotifyStatus();
  void refreshQueueStatus();
  void refreshHistorySummary();
  openModal(ui.settingsModal);
}

function saveApiKey() {
  const key = ui.apiKeyInput.value.trim();
  if (!key) {
    ui.apiKeyStatus.textContent = 'APIキーを入力してください。';
    return;
  }
  try {
    localStorage.setItem(BYOK_STORAGE_KEY, key);
    ui.apiKeyStatus.textContent = 'APIキーを保存しました。';
  } catch {
    ui.apiKeyStatus.textContent = 'このブラウザではキーを保存できません。';
  }
}

function clearApiKey() {
  try {
    localStorage.removeItem(BYOK_STORAGE_KEY);
    ui.apiKeyInput.value = '';
    ui.apiKeyStatus.textContent = 'APIキーを削除しました。共通キーに戻ります。';
  } catch {
    ui.apiKeyStatus.textContent = 'このブラウザではキーを削除できません。';
  }
}

async function exportBackup() {
  try {
    const items = await getAllItems();
    const history = await listConsumption();
    const hints = await listExpiryHints();
    const blob = new Blob([serializeBackup({ items, history, hints })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `receipt-expiry-backup-${todayISO()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.backupStatus.textContent = `在庫${items.length}件・履歴${history.length}件・学習値${hints.length}件を書き出しました。`;
    showToast('バックアップを書き出しました。');
  } catch (error) {
    ui.backupStatus.textContent = error.message || '書き出しに失敗しました。';
    showToast(error.message || '書き出しに失敗しました。');
  }
}

async function handleBackupFileSelected(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = parseBackup(await file.text());
    await importItems(data.items);
    await importConsumption(data.history);
    await importExpiryHints(data.hints);
    state.expiryHints = buildHintMap(await listExpiryHints());
    await refreshItems();
    await refreshHistorySummary();
    ui.backupStatus.textContent = `在庫${data.items.length}件・履歴${data.history.length}件・学習値${data.hints.length}件を読み込みました。`;
    showToast(`${data.items.length}件の在庫を読み込みました。`);
  } catch (error) {
    ui.backupStatus.textContent = error.message || '読み込みに失敗しました。';
    showToast(error.message || '読み込みに失敗しました。');
  }
}

function registerPWAEvents() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    ui.installBtn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    ui.installBtn.classList.add('hidden');
    showToast('ホーム画面に追加しました。');
  });
  ui.installBtn.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    const { outcome } = await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    ui.installBtn.classList.add('hidden');
    if (outcome === 'accepted') showToast('ホーム画面に追加しました。');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || state.didReloadForUpdate) return;
    state.didReloadForUpdate = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // オフラインキャッシュが使えなくても、アプリ本体の利用は継続できる。
    });
  });
}

/* ---------- イベント登録 ---------- */

function wireEvents() {
  byId('scan-btn').addEventListener('click', openSourceModal);
  byId('add-btn').addEventListener('click', () => openEditModal());
  byId('settings-btn').addEventListener('click', openSettings);
  byId('settings-close').addEventListener('click', () => closeModal(ui.settingsModal));

  byId('use-camera').addEventListener('click', () => ui.cameraInput.click());
  byId('use-gallery').addEventListener('click', () => ui.galleryInput.click());
  byId('source-cancel').addEventListener('click', () => closeModal(ui.sourceModal));
  ui.cameraInput.addEventListener('change', handleFileSelected);
  ui.galleryInput.addEventListener('change', handleFileSelected);

  ui.resultItems.addEventListener('click', (event) => {
    if (event.target.closest('.row-remove')) {
      event.target.closest('.result-row').remove();
    }
  });
  byId('result-add-row').addEventListener('click', () => {
    ui.resultItems.append(createResultRow());
  });
  byId('result-cancel').addEventListener('click', () => closeModal(ui.resultModal));
  ui.resultSave.addEventListener('click', () => void saveResult());

  ui.editForm.addEventListener('submit', (event) => void submitEdit(event));
  byId('edit-cancel').addEventListener('click', () => closeModal(ui.editModal));
  ui.editDelete.addEventListener('click', () => void removeEditedItem());


  byId('consume-eaten').addEventListener('click', () => void finishConsume('eaten'));
  byId('consume-discarded').addEventListener('click', () => void finishConsume('discarded'));
  byId('consume-cancel').addEventListener('click', () => {
    state.consumeTarget = null;
    closeModal(ui.consumeModal);
  });
  ui.retryQueueBtn.addEventListener('click', () => void processQueue());
  window.addEventListener('online', () => void processQueue());

  ui.notifyEnableBtn.addEventListener('click', () => void enableNotifications());
  ui.notifyDisableBtn.addEventListener('click', () => void disableNotifications());
  byId('save-api-key').addEventListener('click', saveApiKey);
  byId('clear-api-key').addEventListener('click', clearApiKey);


  ui.exportBackupBtn.addEventListener('click', () => void exportBackup());
  ui.importBackupBtn.addEventListener('click', () => ui.backupInput.click());
  ui.backupInput.addEventListener('change', handleBackupFileSelected);

  ui.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });
  ui.sortSelect.addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderList();
  });


  ui.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.filter = tab.dataset.storage;
    for (const button of ui.tabs.querySelectorAll('.tab')) {
      const active = button === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
    renderList();
  });

  for (const overlay of [ui.sourceModal, ui.resultModal, ui.editModal, ui.consumeModal, ui.settingsModal]) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal(overlay);
    });
  }
  document.addEventListener('keydown', (event) => {
    const top = state.modalStack[state.modalStack.length - 1];
    if (!top) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(top);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(top.querySelectorAll('button, input, select, textarea, [href]'))
      .filter((element) => !element.disabled && element.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  registerPWAEvents();
}

async function init() {
  wireEvents();
  registerServiceWorker();
  try {
    await initDB();

    state.expiryHints = buildHintMap(await listExpiryHints());
    await refreshQueueStatus();

    await syncPushReminder();
    await refreshHistorySummary();
    await processQueue();
    await refreshItems();
  } catch (error) {
    showToast(error.message || '在庫を読み込めませんでした。');
  }
}

void init();

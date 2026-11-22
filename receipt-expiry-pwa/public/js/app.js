import { initDB, addItemsBulk, getAllItemsSorted, updateItem, deleteItem } from './db.js';
import { processReceiptImage } from './imageProcessor.js';
import { analyzeReceipt, isValidDate } from './apiClient.js';

const STORAGE_LABELS = { fridge: '冷蔵', freezer: '冷凍', pantry: '常温' };
const BYOK_STORAGE_KEY = 'receipt-expiry-gemini-key';

const byId = (id) => document.getElementById(id);
const ui = {
  tabs: byId('storage-tabs'),
  list: byId('item-list'),
  itemCount: byId('item-count'),
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
  cameraInput: byId('camera-input'),
  galleryInput: byId('gallery-input'),
  itemTemplate: byId('item-card-template'),
  rowTemplate: byId('result-row-template'),
  toast: byId('toast'),
};

const state = {
  items: [],
  filter: 'all',
  editingId: null,
  resultPurchaseDate: null,
  deferredInstallPrompt: null,
  toastTimer: null,
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
  element.classList.remove('hidden');
}

function closeModal(element) {
  element.classList.add('hidden');
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
}

function renderList() {
  const visible = state.filter === 'all'
    ? state.items
    : state.items.filter((item) => item.storage === state.filter);

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

async function analyzeFile(file) {
  closeModal(ui.sourceModal);
  showLoading(true);
  try {
    const { base64, mimeType } = await processReceiptImage(file);
    const result = await analyzeReceipt({
      imageBase64: base64,
      mimeType,
      clientDate: todayISO(),
      customApiKey: getApiKey() || undefined,
    });
    if (result.items.length === 0) {
      showToast('食材が見つかりませんでした。別の画像をお試しください。');
      return;
    }
    openResultModal(result);
  } catch (error) {
    showToast(error.message || '解析に失敗しました。');
  } finally {
    showLoading(false);
  }
}

/* ---------- 解析結果の確認・一括登録 ---------- */

function createResultRow(item = {}) {
  const row = ui.rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.field-name').value = item.name || '';
  row.querySelector('.field-storage').value = item.storage || 'fridge';
  row.querySelector('.field-expiry').value = item.expiryDate || defaultExpiryISO();
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
  try {
    if (state.editingId) {
      const original = state.items.find((item) => item.id === state.editingId);
      if (!original) throw new Error('編集対象が見つかりません。');
      await updateItem({ ...original, ...fields });
    } else {
      await addItemsBulk([{ ...fields, purchaseDate: todayISO() }]);
    }
    closeModal(ui.editModal);
    await refreshItems();
    showToast(state.editingId ? '食材を更新しました。' : '食材を追加しました。');
  } catch (error) {
    showToast(error.message || '保存に失敗しました。');
  }
}

async function removeEditedItem() {
  if (!state.editingId) return;
  if (!window.confirm('この食材を消費済みとして削除しますか？')) return;
  try {
    await deleteItem(state.editingId);
    closeModal(ui.editModal);
    await refreshItems();
    showToast('削除しました。');
  } catch (error) {
    showToast(error.message || '削除に失敗しました。');
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

  byId('save-api-key').addEventListener('click', saveApiKey);
  byId('clear-api-key').addEventListener('click', clearApiKey);

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

  for (const overlay of [ui.sourceModal, ui.resultModal, ui.editModal, ui.settingsModal]) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal(overlay);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openOverlays = [ui.settingsModal, ui.editModal, ui.resultModal, ui.sourceModal]
      .filter((overlay) => !overlay.classList.contains('hidden'));
    if (openOverlays.length) closeModal(openOverlays[0]);
  });

  registerPWAEvents();
}

async function init() {
  wireEvents();
  registerServiceWorker();
  try {
    await initDB();
    await refreshItems();
  } catch (error) {
    showToast(error.message || '在庫を読み込めませんでした。');
  }
}

void init();

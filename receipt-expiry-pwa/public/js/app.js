import { initDB, addItemsBulk, getAllItemsSorted, updateItem, deleteItem, enqueueAnalysis, addConsumption, listConsumption, saveExpiryHint, listExpiryHints, addShoppingItems, listShoppingItems, deleteShoppingItem } from './db.js';
import { processReceiptImage } from './imageProcessor.js';
import { analyzeReceipt, isValidDate } from './apiClient.js';
import { createQueuedAnalysis } from './queue.js';
import { createConsumption, summarizeHistory } from './history.js';
import { createExpiryHint, buildHintMap, normalizeFoodName } from './learning.js';
import { filterAndSortItems } from './inventory.js';
import { buildShoppingSuggestions, buildCalendar } from './features2.js';
import { createSettings, applyStoredTheme } from './settings.js';
import { createQueueUI } from './queueUI.js';

applyStoredTheme();

const STORAGE_LABELS = { fridge: '冷蔵', freezer: '冷凍', pantry: '常温' };

const byId = (id) => document.getElementById(id);
const ui = {
  tabs: byId('storage-tabs'),
  list: byId('item-list'),
  itemCount: byId('item-count'),

  shoppingModal: byId('shopping-modal'),
  shoppingSuggestions: byId('shopping-suggestions'),
  shoppingItems: byId('shopping-items'),
  calendarView: byId('calendar-view'),
  viewToggle: byId('view-toggle'),
  previewModal: byId('preview-modal'),
  previewImage: byId('preview-image'),
  previewProgress: byId('preview-progress'),

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

  backupReplace: byId('backup-replace'),

  queueStatus: byId('queue-status'),
  retryQueueBtn: byId('retry-queue-btn'),

  queueList: byId('queue-list'),
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

  savingKey: false,

  previewFiles: [],
  previewIndex: 0,
  previewResults: [],
  previewRotate: 0,
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(),
};


const queueUI = createQueueUI({ ui, state, showToast, submitAnalysis });
const settings = createSettings({
  ui,
  state,
  byId,
  showToast,
  openModal,
  todayISO,
  isValidDate,
  refreshItems,
  refreshHistorySummary,
  refreshQueueStatus: () => queueUI.refreshQueueStatus(),
});

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

  void settings.syncPushReminder();
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
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) openPreview(files);
}

function openPreview(files) {
  closeModal(ui.sourceModal);
  state.previewFiles = files;
  state.previewIndex = 0;
  state.previewResults = [];
  state.previewRotate = 0;
  for (const id of ['crop-top', 'crop-bottom', 'crop-left', 'crop-right']) byId(id).value = '0';
  renderPreview();
  openModal(ui.previewModal);
}

function renderPreview() {
  const file = state.previewFiles[state.previewIndex];
  if (!file) return;
  if (ui.previewImage.src.startsWith('blob:')) URL.revokeObjectURL(ui.previewImage.src);
  ui.previewImage.src = URL.createObjectURL(file);
  ui.previewImage.style.transform = `rotate(${state.previewRotate}deg)`;
  ui.previewProgress.textContent = `${state.previewIndex + 1}/${state.previewFiles.length}`;
  byId('preview-confirm').textContent = state.previewIndex + 1 < state.previewFiles.length ? '次の画像へ' : '解析する';
}

function cropOptions() {
  return {
    top: Number(byId('crop-top').value) / 100,
    bottom: Number(byId('crop-bottom').value) / 100,
    left: Number(byId('crop-left').value) / 100,
    right: Number(byId('crop-right').value) / 100,
  };
}

async function confirmPreview() {
  const file = state.previewFiles[state.previewIndex];
  if (!file) return;
  showLoading(true);
  try {
    const { base64, mimeType } = await processReceiptImage(file, {
      rotate: state.previewRotate,
      crop: cropOptions(),
    });
    state.previewResults.push({ imageBase64: base64, mimeType, clientDate: todayISO() });
    state.previewIndex += 1;
    if (state.previewIndex < state.previewFiles.length) {
      renderPreview();
    } else {
      closeModal(ui.previewModal);
      await submitProcessed(state.previewResults);
    }
  } catch (error) {
    showToast(error.message || '画像を処理できませんでした。');
  } finally {
    showLoading(false);
  }
}

async function submitProcessed(payloads) {
  if (!navigator.onLine) {
    for (const payload of payloads) await enqueueAnalysis(createQueuedAnalysis(payload));
    await queueUI.refreshQueueStatus();
    showToast(`${payloads.length}件をオフラインキューに保存しました。`);
    return;
  }
  await submitAnalyses(payloads);
}

async function submitAnalyses(payloads) {
  showLoading(true);
  try {
    const allItems = [];
    let purchaseDate = null;
    for (const payload of payloads) {
      try {
        const result = await analyzeReceipt({ ...payload, customApiKey: settings.getApiKey() || undefined });
        if (!purchaseDate && result.purchaseDate) purchaseDate = result.purchaseDate;
        allItems.push(...result.items);
      } catch (error) {
        showToast(error.message || '解析に失敗しました。');
      }
    }
    if (allItems.length) openResultModal({ purchaseDate, items: allItems });
    else showToast('食材が見つかりませんでした。');
  } finally {
    showLoading(false);
  }
}

async function submitAnalysis(payload) {
  await submitAnalyses([payload]);
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


function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `shop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function refreshShopping() {
  const history = await listConsumption();
  const suggestions = buildShoppingSuggestions(history, state.items);
  const saved = await listShoppingItems();

  state.shoppingCache = saved;

  ui.shoppingSuggestions.replaceChildren();
  for (const suggestion of suggestions) {
    const row = document.createElement('div');
    row.className = 'shopping-row';
    const label = document.createElement('span');
    label.textContent = `${suggestion.name}（${suggestion.count}回）`;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.name = suggestion.name;
    button.textContent = '追加';
    row.append(label, button);
    ui.shoppingSuggestions.append(row);
  }

  ui.shoppingItems.replaceChildren();
  for (const item of saved) {
    const row = document.createElement('div');
    row.className = 'shopping-row';
    const label = document.createElement('span');
    label.textContent = item.name;
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.add = item.id;
    add.textContent = '在庫へ';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.remove = item.id;
    remove.textContent = '削除';
    row.append(label, add, remove);
    ui.shoppingItems.append(row);
  }
}

async function openShopping() {
  await refreshShopping();
  openModal(ui.shoppingModal);
}

function renderCalendar() {
  const days = buildCalendar(state.items, state.calendarYear, state.calendarMonth);
  const firstDay = new Date(state.calendarYear, state.calendarMonth, 1).getDay();
  const dayCount = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  const header = document.createElement('div');
  header.className = 'calendar-header';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.dataset.calendar = 'prev';
  prev.textContent = '‹';
  const label = document.createElement('strong');
  label.textContent = `${state.calendarYear}年 ${state.calendarMonth + 1}月`;
  const next = document.createElement('button');
  next.type = 'button';
  next.dataset.calendar = 'next';
  next.textContent = '›';
  header.append(prev, label, next);
  for (let i = 0; i < firstDay; i += 1) {
    const empty = document.createElement('div');
    empty.className = 'calendar-cell is-empty';
    grid.append(empty);
  }
  for (let day = 1; day <= dayCount; day += 1) {
    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    const number = document.createElement('div');
    number.className = 'calendar-day';
    number.textContent = String(day);
    cell.append(number);
    for (const item of days.get(day) || []) {
      const name = document.createElement('div');
      name.className = 'calendar-item';
      name.textContent = item.name;
      cell.append(name);
    }
    grid.append(cell);
  }
  ui.calendarView.replaceChildren(header, grid);
}

function toggleView() {
  const showingCalendar = !ui.calendarView.classList.contains('hidden');
  if (showingCalendar) {
    ui.calendarView.classList.add('hidden');
    ui.list.classList.remove('hidden');
    ui.emptyState.classList.toggle('hidden', state.items.length > 0);
    ui.viewToggle.textContent = 'カレンダー';
  } else {
    renderCalendar();
    ui.calendarView.classList.remove('hidden');
    ui.list.classList.add('hidden');
    ui.emptyState.classList.add('hidden');
    ui.viewToggle.textContent = '一覧';
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
  byId('settings-btn').addEventListener('click', settings.openSettings);
  byId('settings-close').addEventListener('click', () => closeModal(ui.settingsModal));

  byId('use-camera').addEventListener('click', () => ui.cameraInput.click());
  byId('use-gallery').addEventListener('click', () => ui.galleryInput.click());
  byId('source-cancel').addEventListener('click', () => closeModal(ui.sourceModal));
  ui.cameraInput.addEventListener('change', handleFileSelected);
  ui.galleryInput.addEventListener('change', handleFileSelected);


  byId('preview-rotate').addEventListener('click', () => {
    state.previewRotate = (state.previewRotate + 90) % 360;
    ui.previewImage.style.transform = `rotate(${state.previewRotate}deg)`;
  });
  byId('preview-confirm').addEventListener('click', () => void confirmPreview());
  byId('preview-cancel').addEventListener('click', () => closeModal(ui.previewModal));

  byId('shopping-btn').addEventListener('click', () => void openShopping());
  byId('shopping-close').addEventListener('click', () => closeModal(ui.shoppingModal));
  ui.shoppingSuggestions.addEventListener('click', (event) => {
    const name = event.target.dataset.name;
    if (!name) return;
    void addShoppingItems([{ id: makeId(), name, createdAt: Date.now() }]).then(refreshShopping);
  });
  ui.shoppingItems.addEventListener('click', (event) => {
    const addId = event.target.dataset.add;
    const removeId = event.target.dataset.remove;
    if (addId) {
      const item = (state.shoppingCache || []).find((entry) => entry.id === addId);
      void (async () => {
        if (item) {
          await addItemsBulk([{ name: item.name, storage: 'pantry', expiryDate: defaultExpiryISO(), quantity: '' }]);
          await refreshItems();
        }
        await deleteShoppingItem(addId);
        await refreshShopping();
        showToast('在庫に追加しました。');
      })();
    } else if (removeId) {
      void deleteShoppingItem(removeId).then(refreshShopping);
    }
  });

  ui.viewToggle.addEventListener('click', toggleView);
  ui.calendarView.addEventListener('click', (event) => {
    const direction = event.target.dataset.calendar;
    if (!direction) return;
    if (direction === 'prev') state.calendarMonth -= 1;
    else state.calendarMonth += 1;
    if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear -= 1; }
    if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear += 1; }
    renderCalendar();
  });

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
  queueUI.wire();
  settings.wire();

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

  for (const overlay of [ui.sourceModal, ui.previewModal, ui.shoppingModal, ui.resultModal, ui.editModal, ui.consumeModal, ui.settingsModal]) {
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
    await queueUI.refreshQueueStatus();

    await settings.syncPushReminder();
    await refreshHistorySummary();

    await refreshShopping();
    await queueUI.processQueue();
    await refreshItems();
  } catch (error) {
    showToast(error.message || '在庫を読み込めませんでした。');
  }
}

void init();

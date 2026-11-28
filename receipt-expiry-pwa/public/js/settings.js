import { getAllItems, listConsumption, listExpiryHints, importItems, importConsumption, importExpiryHints, clearAllData, listShoppingItems, addShoppingItems } from './db.js';
import {
  serializeBackup,
  parseBackup,
  LAST_BACKUP_KEY,
  isBackupStale,
  formatLastBackupDate,
} from './backup.js';
import { buildHintMap } from './learning.js';
import { daysUntilDate } from './dates.js';
import { THEMES, DEFAULT_NOTIFY_HOUR } from './domain.js';

const NOTIFY_STORAGE_KEY = 'receipt-expiry-notify';
const THEME_STORAGE_KEY = 'receipt-expiry-theme';
const NOTIFY_HOUR_KEY = 'receipt-expiry-notify-hour';
const AD_CONSENT_KEY = 'receipt-expiry-ad-consent';
const API_KEY_SESSION_KEY = 'receipt-expiry-api-key';

function storedAdConsent() {
  try {
    return localStorage.getItem(AD_CONSENT_KEY);
  } catch {
    return null;
  }
}

function initConsentMode() {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
}

initConsentMode();

function notifyHour() {
  try {
    const raw = localStorage.getItem(NOTIFY_HOUR_KEY);
    if (raw === null) return DEFAULT_NOTIFY_HOUR;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= 23 ? value : DEFAULT_NOTIFY_HOUR;
  } catch {
    return DEFAULT_NOTIFY_HOUR;
  }
}

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.includes(value) ? value : THEMES[0];
  } catch {
    return THEMES[0];
  }
}

export function applyStoredTheme() {
  const theme = storedTheme();
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

export function createSettings({ ui, state, byId, showToast, openModal, todayISO, isValidDate, refreshItems, refreshHistorySummary, refreshQueueStatus }) {
  // このタブを閉じるまで保持するオプション。localStorage には書かない。
  try {
    const stored = sessionStorage.getItem(API_KEY_SESSION_KEY);
    if (stored) state.byokApiKey = stored;
  } catch {
    // sessionStorage が使えない場合はメモリのみ。
  }

  function getApiKey() {
    return state.byokApiKey || '';
  }

  function isNotifyEnabled() {
    try {
      return localStorage.getItem(NOTIFY_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  // ローカル購読の有無とサーバー側の 410 を別に保持する。
  // 片方の再検証で他方の警告が消えないようにするため。
  let localSubscriptionMissing = false;
  let serverSubscriptionMissing = false;

  function refreshNotifyStatus() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      ui.notifyStatus.textContent = 'このブラウザは通知に対応していません。';
      return;
    }
    const time = `日本時間 ${String(notifyHour()).padStart(2, '0')}:00`;
    if (!isNotifyEnabled()) {
      localSubscriptionMissing = false;
      serverSubscriptionMissing = false;
      ui.notifyStatus.textContent = `リマインダ通知は無効です。有効にすると ${time} にお知らせします。`;
      return;
    }
    const permission = Notification.permission === 'granted' ? 'ブラウザの許可あり'
      : Notification.permission === 'denied' ? 'ブラウザの許可なし' : 'ブラウザの許可を確認中';
    if (localSubscriptionMissing || serverSubscriptionMissing) {
      ui.notifyStatus.textContent = `リマインダ通知は有効ですが、この端末への通知の登録が見つかりません。通知が届かない場合は、通知を一度無効にしてから有効にしてください（${time} / ${permission}）。`;
      return;
    }
    ui.notifyStatus.textContent = `リマインダ通知は有効です（${time} / ${permission}）。`;
  }

  async function currentPushSubscription() {
    if (!isNotifyEnabled() || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function refreshSubscriptionStatus() {
    if (!isNotifyEnabled()) {
      localSubscriptionMissing = false;
      serverSubscriptionMissing = false;
      refreshNotifyStatus();
      return;
    }
    try {
      const subscription = await currentPushSubscription();
      localSubscriptionMissing = !subscription;
    } catch {
      // 取得失敗では既存の表示を維持し、在庫操作を止めない。
    }
    refreshNotifyStatus();
  }

  function refreshApiKeyStatus() {
    ui.apiKeyInput.value = '';
    ui.apiKeyStatus.textContent = getApiKey()
      ? (() => {
        let kept = false;
        try { kept = Boolean(sessionStorage.getItem(API_KEY_SESSION_KEY)); } catch { /* 保存不可 */ }
        return kept
          ? 'APIキーを使用中です（このタブを閉じるまで保持します）。'
          : 'このセッションでAPIキーを使用中です（再読み込みで消去されます）。';
      })()
      : '未設定の場合は、アプリ側の共通キーで読み取ります。';
  }
  function applyAdConsent(value) {
    try { localStorage.setItem(AD_CONSENT_KEY, value); } catch { /* 保存不可でも反映する */ }
    const granted = value === 'granted';
    window.gtag('consent', 'update', {
      ad_storage: granted ? 'granted' : 'denied',
      analytics_storage: granted ? 'granted' : 'denied',
      ad_user_data: granted ? 'granted' : 'denied',
      ad_personalization: granted ? 'granted' : 'denied',
    });
    byId('ad-consent').classList.add('hidden');
    if (granted) {
      void loadMonetization();
    } else {
      byId('ad-status').textContent = '広告は無効に設定されています。';
      byId('ad-slot').replaceChildren();
    }
  }

  async function loadMonetization() {
    const consent = storedAdConsent();
    if (consent === null) {
      byId('ad-consent').classList.remove('hidden');
      byId('ad-status').textContent = '広告の同意を選択してください。';
      return;
    }
    if (consent === 'denied') {
      byId('ad-status').textContent = '広告は無効に設定されています。';
      byId('ad-slot').replaceChildren();
      return;
    }

    try {
      const config = await fetch('/api/config').then((response) => response.json());
      if (config.supportUrl) byId('support-link').href = config.supportUrl;
      const slot = byId('ad-slot');
      const client = config.adsenseClient;
      if (client) {
        byId('ad-status').textContent = config.adsenseSlot
          ? '広告を表示しています。'
          : '自動広告を有効にしました（サイト審査後に配信開始）。';
        if (!document.querySelector('script[data-adsense]')) {
          const script = document.createElement('script');
          script.async = true;
          script.dataset.adsense = '1';
          script.crossOrigin = 'anonymous';
          script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
          document.head.append(script);
        }
        if (config.adsenseSlot) {
          if (!slot.firstChild) {
            const ad = document.createElement('ins');
            ad.className = 'adsbygoogle';
            ad.style.display = 'block';
            ad.dataset.adClient = client;
            ad.dataset.adSlot = config.adsenseSlot;
            ad.dataset.adFormat = 'auto';
            slot.append(ad);
            (window.adsbygoogle = window.adsbygoogle || []).push({});
          }
        } else {
          slot.replaceChildren();
        }
      } else {
        byId('ad-status').textContent = '広告は現在無効です（スポンサー募集中）。';
        slot.replaceChildren();
      }
    } catch {
      byId('ad-status').textContent = '広告設定を取得できませんでした。';
    }
  }



  function storedLastBackup() {
    try {
      return localStorage.getItem(LAST_BACKUP_KEY);
    } catch {
      return null;
    }
  }

  function refreshBackupReminder() {
    const last = storedLastBackup();
    const date = formatLastBackupDate(last);
    const stale = isBackupStale(last);
    ui.backupReminder.classList.toggle('hidden', !stale);
    if (stale) {
      ui.backupReminder.textContent = date
        ? `最終バックアップは ${date} です。7日以上経過したので書き出しをおすすめします。`
        : 'バックアップの記録がありません。初めて書き出すことをおすすめします。';
    }
  }

  function openSettings() {
    refreshApiKeyStatus();
    ui.backupStatus.textContent = '';
    ui.backupReplace.checked = false;
    refreshBackupReminder();

    byId('theme-select').value = storedTheme();

    const hourSelect = byId('notify-hour');
    if (!hourSelect.options.length) {
      for (let hour = 0; hour < 24; hour += 1) {
        const option = document.createElement('option');
        option.value = String(hour);
        option.textContent = `${hour}:00`;
        hourSelect.append(option);
      }
    }
    hourSelect.value = String(notifyHour());
    refreshNotifyStatus();
    void refreshSubscriptionStatus();
    refreshQueueStatus();
    refreshHistorySummary();
    void loadMonetization();

    openModal(ui.settingsModal);
  }

  async function saveApiKey() {
    if (state.savingKey) return;
    const key = ui.apiKeyInput.value.trim();
    if (!key) {
      ui.apiKeyStatus.textContent = 'APIキーを入力してください。';
      return;
    }
    state.savingKey = true;
    const button = byId('save-api-key');
    button.disabled = true;
    ui.apiKeyStatus.textContent = 'APIキーを検証しています…';
    try {
      const response = await fetch('/api/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        ui.apiKeyStatus.textContent = data?.error?.code === 'INVALID_KEY'
          ? 'APIキーが無効です。入力内容を確認してください。'
          : 'APIキーを検証できませんでした。しばらくして再度お試しください。';
        return;
      }
      state.byokApiKey = key;
      if (byId('save-api-key-session').checked) {
        try { sessionStorage.setItem(API_KEY_SESSION_KEY, key); } catch { /* 保存不可でもメモリでは使う */ }
      } else {
        try { sessionStorage.removeItem(API_KEY_SESSION_KEY); } catch { /* 保存不可でも無視 */ }
      }
      ui.apiKeyStatus.textContent = byId('save-api-key-session').checked
        ? 'APIキーを検証しました。このタブを閉じるまで保持します。'
        : 'APIキーを検証しました。このセッションでのみ使用します。';
    } catch {
      ui.apiKeyStatus.textContent = 'APIキーを検証できませんでした。通信環境を確認してください。';
    } finally {
      state.savingKey = false;
      button.disabled = false;
    }
  }

  function clearApiKey() {
    state.byokApiKey = '';
    ui.apiKeyInput.value = '';
    try { sessionStorage.removeItem(API_KEY_SESSION_KEY); } catch { /* 保存不可でも無視 */ }
    byId('save-api-key-session').checked = false;
    ui.apiKeyStatus.textContent = 'APIキーを削除しました。共通キーに戻ります。';
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
        ui.notifyStatus.textContent = 'このブラウザは通知に対応していません。';
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
      serverSubscriptionMissing = false;
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
    if (!isNotifyEnabled()) {
      localSubscriptionMissing = false;
      serverSubscriptionMissing = false;
      refreshNotifyStatus();
      return;
    }
    if (state.syncingPush) return;
    state.syncingPush = true;
    try {
      const subscription = await currentPushSubscription();
      localSubscriptionMissing = !subscription;
      refreshNotifyStatus();
      if (!subscription) return;
      const dates = state.items
        .map((item) => item.expiryDate)
        .filter((date) => isValidDate(date))
        .sort();
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          nextExpiry: dates[0] || null,
          expiryDates: dates.slice(0, 20),
          daysUntil: dates[0] ? daysUntilDate(dates[0]) : null,

          notifyHour: notifyHour(),
        }),
      });
      if (response.status === 410) {
        // サーバー側で購読が失われた場合も、ボタンを増やさず表示だけで伝える。
        serverSubscriptionMissing = true;
        refreshNotifyStatus();
      }
    } catch {
      // 通知の同期失敗は在庫操作を止めない。
    } finally {
      state.syncingPush = false;
    }
  }

  async function exportBackup() {
    try {
      const items = await getAllItems();
      const history = await listConsumption();
      const hints = await listExpiryHints();
      const shopping = await listShoppingItems();
      const backupSettings = {
        theme: storedTheme(),
        notifyHour: notifyHour(),
        notifyEnabled: isNotifyEnabled(),
      };
      const blob = new Blob([serializeBackup({ items, history, hints, shopping, settings: backupSettings })], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `receipt-expiry-backup-${todayISO()}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try {
        localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
      } catch {
        // 保存不可でも書き出し自体は成功として扱う。
      }
      refreshBackupReminder();
      ui.backupStatus.textContent = `在庫${items.length}件・履歴${history.length}件・期限の記憶${hints.length}件・買い物${shopping.length}件を書き出しました。`;
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
      const incoming = `在庫${data.items.length}件・履歴${data.history.length}件・期限の記憶${data.hints.length}件・買い物${data.shopping.length}件`;
      if (ui.backupReplace.checked) {
        const currentItems = await getAllItems();
        const message = `既存の在庫${currentItems.length}件・履歴・期限の記憶・買い物・保存済みのレシートをすべて削除し、
バックアップの内容（${incoming}）で置き換えます。よろしいですか？`;
        if (!window.confirm(message)) return;
        await clearAllData();
      } else if (!window.confirm(`バックアップの内容（${incoming}）を既存データに追加・上書きします。よろしいですか？`)) {
        return;
      }
      await importItems(data.items);
      await importConsumption(data.history);
      await importExpiryHints(data.hints);

      await addShoppingItems(data.shopping);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, data.settings.theme);
        localStorage.setItem(NOTIFY_HOUR_KEY, String(data.settings.notifyHour));
        localStorage.setItem(NOTIFY_STORAGE_KEY, data.settings.notifyEnabled ? '1' : '0');
      } catch { /* 設定の保存不可でも復元を続ける */ }
      applyStoredTheme();
      state.expiryHints = buildHintMap(await listExpiryHints());
      await refreshItems();
      await refreshHistorySummary();
      ui.backupStatus.textContent = `在庫${data.items.length}件・履歴${data.history.length}件・期限の記憶${data.hints.length}件・買い物${data.shopping.length}件を読み込みました。`;
      showToast(`${data.items.length}件の在庫を読み込みました。`);
    } catch (error) {
      ui.backupStatus.textContent = error.message || '読み込みに失敗しました。';
      showToast(error.message || '読み込みに失敗しました。');
    }
  }

  function wireSettingsTabs() {
    const tabs = document.querySelectorAll('[data-settings-tab]');
    const panels = document.querySelectorAll('[data-settings-panel]');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const name = tab.dataset.settingsTab;
        for (const item of tabs) {
          const active = item === tab;
          item.classList.toggle('is-active', active);
          item.setAttribute('aria-selected', String(active));
        }
        for (const panel of panels) {
          panel.hidden = panel.dataset.settingsPanel !== name;
        }
      });
    }
  }


  function wire() {
    byId('ad-consent-accept').addEventListener('click', () => applyAdConsent('granted'));
    byId('ad-consent-decline').addEventListener('click', () => applyAdConsent('denied'));

    byId('save-api-key').addEventListener('click', () => void saveApiKey());
    byId('clear-api-key').addEventListener('click', clearApiKey);
    ui.exportBackupBtn.addEventListener('click', () => void exportBackup());
    ui.importBackupBtn.addEventListener('click', () => ui.backupInput.click());
    ui.backupInput.addEventListener('change', handleBackupFileSelected);
    ui.notifyEnableBtn.addEventListener('click', () => void enableNotifications());
    ui.notifyDisableBtn.addEventListener('click', () => void disableNotifications());
    byId('notify-hour').addEventListener('change', (event) => {
      try { localStorage.setItem(NOTIFY_HOUR_KEY, event.target.value); } catch { /* 保存不可でも反映する */ }
      void syncPushReminder();
      refreshNotifyStatus();
      showToast(`通知時刻を日本時間 ${String(event.target.value).padStart(2, '0')}:00 にしました。`);
    });

    byId('theme-select').addEventListener('change', (event) => {
      const theme = event.target.value;
      try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* 保存不可でも切替は反映する */ }
      applyStoredTheme();
    });

    wireSettingsTabs();
  }

  return {

    getApiKey, openSettings, syncPushReminder, refreshNotifyStatus, refreshApiKeyStatus, refreshBackupReminder,
    applyStoredTheme, loadMonetization, wire,
  };
}

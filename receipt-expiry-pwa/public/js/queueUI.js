import { listQueuedAnalyses, updateQueuedAnalysis, deleteQueuedAnalysis } from './db.js';
import { nextAttempt, shouldDiscard } from './queue.js';
export function createQueueUI({ ui, state, showToast, submitAnalysis }) {
  function renderQueueList(jobs) {
    ui.queueList.replaceChildren();
    for (const job of jobs) {
      const row = document.createElement('div');
      row.className = 'queue-row';
      const info = document.createElement('span');
      info.className = 'queue-row-info';
      const created = new Date(job.createdAt || Date.now()).toLocaleString('ja-JP');
      info.textContent = `${created} ／ 試行 ${Number(job.attempts) || 0}/3`;
      const actions = document.createElement('span');
      actions.className = 'queue-row-actions';
      for (const [action, label] of [['retry', '再試行'], ['delete', '削除']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.dataset.id = job.id;
        button.textContent = label;
        actions.append(button);
      }
      row.append(info, actions);
      ui.queueList.append(row);
    }
  }

  async function refreshQueueStatus() {
    const jobs = await listQueuedAnalyses();
    ui.queueStatus.textContent = jobs.length ? `未送信の解析: ${jobs.length}件` : '未送信の解析はありません。';
    ui.retryQueueBtn.disabled = jobs.length === 0;
    renderQueueList(jobs);
  }

  async function retryQueueJob(id) {
    if (state.processingQueue) return;
    state.processingQueue = true;
    try {
      const jobs = await listQueuedAnalyses();
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return;
      try {
        await submitAnalysis({ imageBase64: job.imageBase64, mimeType: job.mimeType, clientDate: job.clientDate });
        await deleteQueuedAnalysis(id);
        showToast('解析が完了しました。');
      } catch (error) {
        const attempted = nextAttempt(job);
        if (shouldDiscard(attempted)) {
          await deleteQueuedAnalysis(id);
          showToast('解析できなかったため削除しました。');
        } else {
          await updateQueuedAnalysis(attempted);
          showToast(`再試行できませんでした: ${error.message || '不明なエラー'}`);
        }
      }
      await refreshQueueStatus();
    } finally {
      state.processingQueue = false;
    }
  }

  async function deleteQueueJob(id) {
    await deleteQueuedAnalysis(id);
    await refreshQueueStatus();
    showToast('未送信の解析を削除しました。');
  }

  async function processQueue() {
    if (state.processingQueue) return;
    state.processingQueue = true;
    try {
      const jobs = await listQueuedAnalyses();
      for (const job of jobs) {
        try {
          await submitAnalysis({ imageBase64: job.imageBase64, mimeType: job.mimeType, clientDate: job.clientDate });
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

  function wire() {
    ui.retryQueueBtn.addEventListener('click', () => void processQueue());
    ui.queueList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'retry') void retryQueueJob(button.dataset.id);
      if (button.dataset.action === 'delete') void deleteQueueJob(button.dataset.id);
    });
    window.addEventListener('online', () => void processQueue());
  }

  return { refreshQueueStatus, processQueue, wire };
}

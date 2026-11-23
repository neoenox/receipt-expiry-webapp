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

  /** レート制限(429)では試行回数を消費せず、次回試行時刻だけを遅らせる。 */
  async function handleFailure(job, error) {
    const retryAfter = Number(error?.retryAfter) || 0;
    if (retryAfter > 0) {
      await updateQueuedAnalysis({ ...job, nextAttemptAt: Date.now() + retryAfter * 1000 });
      return false;
    }
    const attempted = nextAttempt(job);
    if (shouldDiscard(attempted)) {
      await deleteQueuedAnalysis(job.id);
      showToast('解析できなかったレシートを削除しました。');
      return true;
    }
    await updateQueuedAnalysis(attempted);
    showToast(`再試行できませんでした: ${error.message || '不明なエラー'}`);
    return true;
  }

  async function retryQueueJob(id) {
    if (state.processingQueue) return;
    state.processingQueue = true;
    try {
      const jobs = await listQueuedAnalyses();
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return;
      if (job.nextAttemptAt && Date.now() < job.nextAttemptAt) {
        showToast('レート制限が解除されるまでお待ちください。');
        return;
      }
      try {
        await submitAnalysis({ imageBase64: job.imageBase64, mimeType: job.mimeType, clientDate: job.clientDate });
        await deleteQueuedAnalysis(id);
        showToast('解析が完了しました。');
      } catch (error) {
        await handleFailure(job, error);
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
        if (job.nextAttemptAt && Date.now() < job.nextAttemptAt) continue;
        try {
          await submitAnalysis({ imageBase64: job.imageBase64, mimeType: job.mimeType, clientDate: job.clientDate });
          await deleteQueuedAnalysis(job.id);
        } catch (error) {
          const discarded = await handleFailure(job, error);
          if (discarded) break;
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

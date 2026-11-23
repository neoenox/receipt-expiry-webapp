import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cloudflare KV の get/put/delete/list を模したローカル永続ストア。
 *
 * 値は { v: <value>, e: <expiry epoch ms> } の形で保存し、TTL も永続化する。
 * 書き込みはこのプロセス内で直列化される。複数プロセスから同じファイルを
 * 書かないこと（notify は server.js 内のタイマーに統合済み）。
 */
export function createKvAdapter(filePath) {
  /** @type {Map<string, {v: unknown, e?: number}>} */
  let data = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 旧フォーマット（プレーン値）は期限なしとして移行読み込みする。
        data = new Map(Object.entries(parsed).map(([key, value]) => [
          key,
          value && typeof value === 'object' && 'v' in value ? value : { v: value },
        ]));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(data)), { mode: 0o600 });
    await fs.rename(tmp, filePath);
  }

  function enqueueWrite(task) {
    const result = writeChain.then(task, task);
    writeChain = result.catch(() => {});
    return result;
  }

  function isExpired(entry) {
    return Boolean(entry && Number.isFinite(entry.e) && Date.now() >= entry.e);
  }

  return {
    async get(key) {
      await load();
      const entry = data.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        await this.delete(key);
        return null;
      }
      return entry.v;
    },

    put(key, value, options = {}) {
      const now = Date.now();
      return enqueueWrite(async () => {
        await load();
        const entry = { v: value };
        if (Number.isFinite(options.expirationTtl)) {
          entry.e = now + options.expirationTtl * 1000;
        }
        // TTL なしの put は古い期限を明示的に消す（Cloudflare と同じ挙動）。
        data.set(key, entry);
        await persist();
      });
    },

    delete(key) {
      return enqueueWrite(async () => {
        await load();
        data.delete(key);
        await persist();
      });
    },

    async list({ prefix = '', limit = 1000, cursor } = {}) {
      await load();
      // list にも期限切れキーは出さない。削除は書き込みキューに積んで永続化する。
      let pruned = false;
      for (const [key, entry] of data) {
        if (isExpired(entry)) {
          data.delete(key);
          pruned = true;
        }
      }
      if (pruned) await enqueueWrite(() => persist());
      const keys = Array.from(data.keys())
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const next = start + limit;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
  };
}

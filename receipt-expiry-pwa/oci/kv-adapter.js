import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cloudflare KV の get/put/delete/list を模したローカル永続ストア。
 * 購読やレート制限カウンタは最大 1000 件程度なので JSON ファイルで十分。
 * 書き込みはプロセス内のキューで直列化し、read-modify-write の競合を防ぐ。
 */
export function createKvAdapter(filePath) {
  let data = new Map();
  const expiresAt = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = new Map(Object.entries(parsed));
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

  return {
    async get(key) {
      await load();
      const expiry = expiresAt.get(key);
      if (expiry && Date.now() >= expiry) {
        await this.delete(key);
        return null;
      }
      return data.has(key) ? data.get(key) : null;
    },

    put(key, value, options = {}) {
      return enqueueWrite(async () => {
        await load();
        data.set(key, value);
        await persist();
        // expirationTtl は Cloudflare KV 準拠。期限切れキーは読み取り時に除外する。
        if (Number.isFinite(options.expirationTtl)) {
          // Node の setTimeout は 32bit ms 制限があるため、期限はキーに保持して
          // 読み取り時に判定する（24日を超える TTL でも安全に動く）。
          expiresAt.set(key, Date.now() + options.expirationTtl * 1000);
        }
      });
    },

    delete(key) {
      return enqueueWrite(async () => {
        await load();
        data.delete(key);
        expiresAt.delete(key);
        await persist();
      });
    },

    async list({ prefix = '', limit = 1000, cursor } = {}) {
      await load();
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

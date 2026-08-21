import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

// 用量账本（拍板 2026-08-19）：BYOK 的成本感知——按书累计输入/输出 token 与
// 请求数，全局合计。usage.json 挂在 userData；原子写复用既有模式（tmp+fsync+
// rename，EPERM 退避）。不估价（各厂商价格自算），只记账。
export class UsageStore {
  constructor(path) {
    this.path = path;
    // 内存态：{ books: { [bookId]: { promptTokens, completionTokens, requests, updatedAt } } }
    this.data = null;
    this.writeQueue = Promise.resolve();
    this.dirty = false;
    this.flushTimer = null;
  }

  async #load() {
    if (this.data) return this.data;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      this.data =
        parsed && typeof parsed === "object" && typeof parsed.books === "object"
          ? parsed
          : { books: {} };
    } catch {
      this.data = { books: {} };
    }
    return this.data;
  }

  // 记一笔：bucket=书 id（烧制等无主请求记入 "misc"）。写盘节流 5 秒合批。
  record(bucket, { promptTokens = 0, completionTokens = 0 } = {}) {
    const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens | 0) : 0;
    const completion = Number.isFinite(completionTokens)
      ? Math.max(0, completionTokens | 0)
      : 0;
    // 两个主数都拿不到（非数字/全零）就不记账：usage 缺失的响应不算一次用量。
    if (prompt <= 0 && completion <= 0) return;
    const key = bucket || "misc";
    // 记账链入队：flush 先等全部记账落地再写盘（record 是回调式、无返回值）。
    this.pendingRecords = (this.pendingRecords ?? Promise.resolve())
      .then(() => this.#load())
      .then((data) => {
        const entry = data.books[key] ?? {
          promptTokens: 0,
          completionTokens: 0,
          requests: 0,
          updatedAt: "",
        };
        entry.promptTokens += prompt;
        entry.completionTokens += completion;
        entry.requests += 1;
        entry.updatedAt = new Date().toISOString();
        data.books[key] = entry;
        this.dirty = true;
        this.#scheduleFlush();
      })
      .catch(() => {});
  }

  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeQueue = this.writeQueue.then(() => this.#flush()).catch(() => {});
    }, 5_000);
    // 进程退出时别拦着关窗。
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  async #flush() {
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${Math.random().toString(36).slice(2)}`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(snapshot, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, this.path);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "EBUSY") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  // 退出前的最终落盘（before-quit 调用）。
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.pendingRecords;
    await this.#flush();
  }

  // 下架清账（打磨轮 2026-08-21）：书从案头移除后，账目不再永久挂着
  // 「已下架的书」残行。只清该书自己的桶；misc 与其余书不动。重烧
  // （library:rebake）复用下架函数但不清账——同一本书的用量应累计。
  removeBook(bookId) {
    this.pendingRecords = (this.pendingRecords ?? Promise.resolve())
      .then(() => this.#load())
      .then((data) => {
        if (data.books[bookId] == null) return;
        delete data.books[bookId];
        this.dirty = true;
        this.#scheduleFlush();
      })
      .catch(() => {});
  }

  // 视图：并入书目标题，给全局合计。定性字数（约 N 万字）由渲染层换算。
  async view(titlesById = new Map()) {
    const data = await this.#load();
    const books = Object.entries(data.books).map(([id, entry]) => ({
      id,
      title: titlesById.get(id) ?? (id === "misc" ? "起稿与其他" : "已下架的书"),
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      requests: entry.requests ?? 0,
      updatedAt: entry.updatedAt ?? "",
    }));
    return {
      books,
      total: {
        promptTokens: books.reduce((sum, item) => sum + item.promptTokens, 0),
        completionTokens: books.reduce((sum, item) => sum + item.completionTokens, 0),
        requests: books.reduce((sum, item) => sum + item.requests, 0),
      },
    };
  }
}

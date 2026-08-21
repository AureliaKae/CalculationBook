import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { migrateState, normalizeWorld } from "./evolution.js";

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// 最小结构校验：能解析且 version 正确、但缺字段的文件在 restoreEngine 里会
// 炸成裸 TypeError 打穿恢复 IPC。读路径在这里拦一道，坏档按「没有存档」处理。
function looksLikeSave(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.version === 4 &&
    typeof data.world === "object" &&
    data.world !== null &&
    Array.isArray(data.snapshots) &&
    data.snapshots.length > 0 &&
    Array.isArray(data.history) &&
    Number.isFinite(data.randomState)
  );
}

// 没有存档，只有「续玩点」：每本书一份，覆盖式写入，死亡即清除。
export class ProgressStore {
  constructor(directory) {
    this.directory = directory;
    // 回合数索引：书架列表只读索引，不再为取一个字段全量解析每份存档。
    this.turnIndex = null;
  }

  #path(bookId) {
    return join(this.directory, safeName(bookId) + ".json");
  }

  // 原子替换写入：临时文件 fsync 落盘后直接 rename 覆盖。Node 在 Windows 走
  // MOVEFILE_REPLACE_EXISTING，无需先删旧文件——先删会留下「新旧两份存档同时
  // 消失」的断电窗口。杀软短暂锁住目标文件时 rename 会 EPERM，退避重试几次。
  async #atomicWrite(path, data) {
    const temporary = path + ".tmp";
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
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

  async #readJson(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }

  // 启动时调用一次：采纳/清理上次崩溃残留的 .tmp。tmp 是比主档更新的写入，
  // 内容完整就接管主档位置；损坏则丢弃。
  async recover() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith(".tmp"));
    for (const file of files) {
      await this.#recoverTemporary(join(this.directory, file));
    }
  }

  async #recoverTemporary(temporary) {
    try {
      const content = await readFile(temporary, "utf8");
      if (!looksLikeSave(JSON.parse(content))) {
        await unlink(temporary);
        return;
      }
      await rename(temporary, temporary.slice(0, -4));
    } catch {
      await unlink(temporary).catch(() => {});
    }
  }

  async write(bookId, data) {
    await mkdir(this.directory, { recursive: true });
    await this.#atomicWrite(this.#path(bookId), data);
    // 只把结构完整的存档写进索引（坏档在 #ensureTurnIndex 里同样会被滤掉）。
    if (looksLikeSave(data)) {
      this.turnIndex?.set(data.metadata?.bookId ?? bookId, data.snapshots?.at(-1)?.turn ?? 0);
    }
    return this.#path(bookId);
  }

  async read(bookId) {
    const data = await this.#readJson(this.#path(bookId));
    if (!data) return null;
    // 版本不符或结构不全的存档只忽略、不删除：读操作无副作用，旧档留给
    // 显式清理，避免一次升级/位腐就永久销毁整世进度。
    if (!looksLikeSave(data)) {
      console.warn("[progress] 存档版本不符或结构损坏，已忽略（文件保留）：" + bookId);
      return null;
    }
    return data;
  }

  async clear(bookId) {
    try {
      await unlink(this.#path(bookId));
    } catch {}
    this.turnIndex?.delete(bookId);
  }

  // 书架上要标「第 N 回合」：首次调用全量扫一遍建索引，之后由 write/clear 增量维护。
  async turns() {
    await this.#ensureTurnIndex();
    return Object.fromEntries(this.turnIndex);
  }

  async #ensureTurnIndex() {
    if (this.turnIndex) return;
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith(".json"));
    const entries = await Promise.all(
      files.map(async (file) => {
        try {
          const data = JSON.parse(await readFile(join(this.directory, file), "utf8"));
          if (!looksLikeSave(data) || !data.metadata?.bookId) return null;
          return [data.metadata.bookId, data.snapshots?.at(-1)?.turn ?? 0];
        } catch {
          return null;
        }
      }),
    );
    this.turnIndex = new Map(entries.filter(Boolean));
  }

  // （手动存档槽 writeSlot/readSlot/listSlots/deleteSlot/clearSlots 已随
  // 「只留沉浸式续玩点」拍板删除，2026-08-21；旧 slots/ 目录由主进程启动
  // 时整树清理。）
}

export function serializeEngine(engine, metadata = {}) {
  return {
    version: 4,
    updatedAt: new Date().toISOString(),
    metadata,
    // world 按引用序列化的话，stringify 前若有人改世界（转世写事实），
    // 会落成「新世界 + 旧快照」的错位组合；这里克隆一份与快照同批。
    world: structuredClone(engine.world),
    // 快照只留最近三个：undo 只需要倒数第二个，多留一个是余量。
    // 全量保存会让存档随回合数线性膨胀。
    snapshots: structuredClone(engine.store.snapshots).slice(-3),
    history: structuredClone(engine.history),
    randomState: engine.random.getState(),
    rewriteCount: engine.rewriteCount,
  };
}

export function restoreEngine(engine, saved) {
  if (saved.version !== 4) throw new Error("旧存档已不再支持");
  engine.world = normalizeWorld(saved.world);
  engine.store.snapshots = saved.snapshots.map((state) => migrateState(state, engine.world));
  engine.history = structuredClone(saved.history);
  engine.random.setState(saved.randomState);
  engine.rewriteCount = saved.rewriteCount ?? 0;
  // 旧档迁移：死亡只记在回合史上、没落 playerDead 标记（清档前崩溃残留的
  // 死亡续玩点）。按最后一回合的死亡记录补上，重算 playerDeathState 对
  // 交锋致死会漏成「活着」。
  const lastTurn = engine.history.at(-1);
  if (lastTurn?.death?.dead) {
    const current = engine.store.snapshots[engine.store.snapshots.length - 1];
    current.playerDead = true;
    current.playerDeathCause = String(lastTurn.death.cause ?? "伤重不治");
  }
  // 伏笔增量集合只存在于内存：重启后从历史重建，否则所有已开启的伏笔
  // 都会从后续上下文与检索词里消失，直到模型重新开一次。
  const resolved = new Set(engine.store.current?.resolvedThreads ?? []);
  engine.openThreadSet = new Set(engine.history.flatMap((turn) => turn.openThreads ?? []));
  for (const thread of resolved) engine.openThreadSet.delete(thread);
  return engine;
}

// 阶段终局/死亡状态不在 metadata 里落盘，恢复续玩点时从最后一回合重建：
// 否则阶段终局后关掉应用再打开，界面既没有选项也没有「继续这个角色」按钮，
// 玩家会卡在正文末尾，只能被迫重开一世。
export function resumeEnding(engine) {
  const lastTurn = engine.history.at(-1);
  if (!lastTurn) return null;
  if (lastTurn.death?.dead) {
    return {
      type: "death",
      cause: lastTurn.death.cause,
      name: engine.store.current.player.name,
      turns: lastTurn.number,
    };
  }
  // 阶段终局以快照为准(A5,2026-08-19):continue-stage 只清快照里的
  // endingCandidate、不动回合史——按回合史恢复会把已续写的阶段再复活一次,
  // 反复点「续写新阶段」还会堆积重复的承接目标。
  const current = engine.store.snapshots[engine.store.snapshots.length - 1];
  if (current?.endingCandidate?.ready) {
    return { type: "stage", goalId: current.endingCandidate.goalId };
  }
  return null;
}

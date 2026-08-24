import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { normalizeProject, newPlotProject } from "../src/plotting.js";

// 谋篇项目库（2026-08-24）：userData/plotting/<projectId>/project.json。
// 目录约定照 LibraryStore（books/<bookId>/），原子写复用同一套 tmp+fsync+
// rename、EPERM 退避纪律——这里自持一份，不去引 LibraryStore 的私有实现。

// projectId = "plot-" + 16 位十六进制白名单：与 assertBookId 同理，阻断
// 渲染层经 IPC 传入 `../` 之类路径穿越。
export function newPlotId() {
  return `plot-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function assertPlotId(id) {
  if (typeof id !== "string" || !/^plot-[a-f0-9]{16}$/.test(id)) {
    throw new Error("无效的谋篇项目 ID");
  }
  return id;
}

async function atomicWrite(path, data) {
  const temporary = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(data, "utf8");
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

export class PlotStore {
  constructor(directory) {
    this.directory = directory;
  }

  #dir(id) {
    assertPlotId(id);
    return join(this.directory, id);
  }

  #path(id, file = "project.json") {
    return join(this.#dir(id), file);
  }

  async create({ title = "", idea, genre = "", reference = null, flavor = 3 }) {
    const cleanedIdea = String(idea ?? "").trim();
    if (!cleanedIdea) throw new Error("先写下一句话点子");
    const project = newPlotProject({
      id: newPlotId(),
      title,
      idea: cleanedIdea,
      genre,
      reference,
      flavor,
    });
    await mkdir(this.#dir(project.id), { recursive: true });
    await atomicWrite(this.#path(project.id), JSON.stringify(project, null, 2));
    return project;
  }

  async save(project) {
    const normalized = normalizeProject(project);
    if (!normalized) throw new Error("谋篇档案结构不完整，拒绝写入");
    await mkdir(this.#dir(normalized.id), { recursive: true });
    await atomicWrite(this.#path(normalized.id), JSON.stringify(normalized, null, 2));
    return normalized;
  }

  async load(id) {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.#path(id), "utf8"));
    } catch {
      return null;
    }
    const project = normalizeProject(raw);
    if (!project) {
      console.warn("[plotting] 谋篇档案版本不符或结构损坏，已忽略（文件保留）：" + id);
      return null;
    }
    return project;
  }

  // 项目列表（谋篇面左栏）：只带展示所需的摘要，不带各节全文。
  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^plot-[a-f0-9]{16}$/.test(entry.name))
        .map(async (entry) => {
          const project = await this.load(entry.name);
          return project ? this.summaryOf(project) : null;
        }),
    );
    return projects
      .filter(Boolean)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  summaryOf(project) {
    return {
      id: project.id,
      title: project.title,
      idea: project.seeds.idea,
      genre: project.seeds.genre,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      done: {
        premise: Boolean(project.premise),
        worldview: Boolean(project.worldview),
        style: Boolean(project.style),
        characters: Boolean(project.characters),
        outline: Boolean(project.outline),
        sample: Boolean(project.sample),
      },
    };
  }

  async rename(id, title) {
    const project = await this.load(id);
    if (!project) throw new Error("谋篇项目不存在");
    const cleaned = String(title ?? "").trim().slice(0, 40);
    if (!cleaned) throw new Error("名字不能为空");
    const next = { ...project, title: cleaned, updatedAt: new Date().toISOString() };
    await atomicWrite(this.#path(id), JSON.stringify(next, null, 2));
    return next;
  }

  async remove(id) {
    await rm(this.#dir(id), { recursive: true, force: true });
  }
}

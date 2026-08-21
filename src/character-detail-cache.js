import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { submitCharacterDetailTool } from "./structured-tools.js";

function cacheKey(characterId) {
  return createHash("sha1").update(String(characterId)).digest("hex");
}

// 原子替换写入：裸 writeFile 在崩溃时会留下半截 JSON，下次 load 解析失败
// 触发重烧；tmp fsync 后 rename 覆盖则要么旧档要么新档，不会出现半截。
async function atomicWriteJson(path, data) {
  const temporary = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(data), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export class CharacterDetailCache {
  constructor({ directory, completeJson }) {
    this.directory = directory;
    this.completeJson = completeJson;
    this.pending = new Map();
  }

  async load(characterId) {
    try {
      return JSON.parse(await readFile(join(this.directory, `${cacheKey(characterId)}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  async getOrCreate({ character, sourceChapters, context }) {
    await mkdir(this.directory, { recursive: true });
    const cached = await this.load(character.id);
    if (cached) return cached;
    if (!this.pending.has(character.id)) {
      const request = (async () => {
        // 章节数量与单章长度都要限：超大章节会把精读请求撑爆。按单章 8000 字、
        // 最多 5 章截断，足够模型归纳人物，又不会顶穿上下文。
        const MAX_EXCERPT_CHARS = 8_000;
        const excerpts = sourceChapters
          .filter((chapter) => chapter.index >= character.firstChapter && (!character.lastChapter || chapter.index <= character.lastChapter))
          .slice(0, 5)
          .map(({ index, title, text }) => ({
            index,
            title,
            text: String(text ?? "").slice(0, MAX_EXCERPT_CHARS),
          }));
        const result = await this.completeJson(
          [
            {
              role: "system",
              content:
                "精读这个原著人物，只返回 JSON：role(身份)、summary(当前处境)、motives(动机数组)、habits(行为习惯数组)、resources(资源数组)、constraints(限制数组)、secrets(已出现的秘密数组)。不得添加原文没有的事实。",
            },
            { role: "user", content: JSON.stringify({ character, excerpts }) },
          ],
          { tool: submitCharacterDetailTool() },
        );
        await atomicWriteJson(join(this.directory, `${cacheKey(character.id)}.json`), result);
        return result;
      })().finally(() => this.pending.delete(character.id));
      this.pending.set(character.id, request);
    }
    return this.pending.get(character.id);
  }
}

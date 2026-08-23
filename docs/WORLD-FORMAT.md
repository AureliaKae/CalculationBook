# `.cpworld` 世界文件格式 · 规范 v1

> 推演书的起稿产物分享格式。一个 `.cpworld` 文件 = 一本书的世界档案（可选地带上原文与
> 粗读摘要），在任何一台装了推演书的机器上导入即玩，免去整场起稿。
>
> 本规范面向两类读者：想确认「我导出的文件里到底有什么」的用户，以及想实现兼容
> 读取器的第三方实现者。参考实现：`src/world-bundle.js`（纯 Node，零 Electron 依赖）。

## 设计原则

- **分享的是演绎，不是盗版**。默认的轻装档不含小说原文：世界档案（人物卡、时间线、
  事实、身份目录、文风描述）是模型对原书的结构化演绎，体积通常只有几百 KB。含原文的
  全档定位为自用备份，导出界面明示「只分享你有权分享的内容」。
- **导入文件与 LLM 输出同级不可信**。推演书引擎的宪法是「AI 提议、代码钳位」——模型
  输出永远要过消毒管线。世界文件走同一条纪律：条目白名单、解压预检、逐字段校验、
  机械修复，救不回来的明着拒绝，绝不静默降级。
- **规范形态是稳定不动点**。导出与导入共用同一条收口管线（normalize → 诊断 → 机械
  修复 → 校验），写出的档案永远是规范形态；「解析 → 再导出 → 再解析」得到逐字段
  等价的结果。

## 容器

ZIP 归档（DEFLATE 压缩），扩展名 `.cpworld`。条目白名单——出现任何白名单之外的
条目即整体拒绝（兼容读取器应当同样拒绝）：

| 条目 | 必带 | 内容 |
| --- | --- | --- |
| `manifest.json` | 是 | 格式声明（见下） |
| `world.json` | 是 | `{ world, initialState }`，与书库 `books/<id>/world.json` 同构 |
| `chapter-index.json` | 是 | `[{ "index": 1, "title": "第一章 …" }]`，章号锚系目录 |
| `chapters.json` | 仅全档 | 清洗后的原文：`[{ index, title, text }]` |
| `canon-summaries.jsonl` | 仅全档 | 粗读摘要追加日志，每行 `{ "index": 0, "summary": "…" }` |
| `character-cache/<sha1hex>.json` | 可选 | 人物精读缓存，文件名为 `sha1(人物id)` 的十六进制 |

约束：

- 章号必须是 ≥1 的整数且**严格递增**（人物 `firstChapter`/`lastChapter` 过滤、批次划分
  都按 index 值对齐，重复或乱序会让锚点错位）。
- `canon-summaries.jsonl` 的缓存键含原文哈希，**不允许脱离 `chapters.json` 存在**。
- 人物精读缓存单文件 ≤ 64KB、总数 ≤ 500；摘要行数 ≤ 1000，`canon-summaries.jsonl` 本体 ≤ 4MB。
- 体积上限：文件本体 ≤ 256MB，解压总量 ≤ 512MB，原文总量 ≤ 1000 万字（与小说导入同档）。

## manifest.json

```json
{
  "formatVersion": 1,
  "kind": "world-bundle",
  "meta": {
    "title": "灰港余烬",
    "format": "txt",
    "chapterCount": 2
  },
  "includes": {
    "chapters": false,
    "summaries": false,
    "characterCache": 1
  },
  "provenance": {
    "schemaVersion": 5,
    "appVersion": "0.1.0",
    "bakedAt": "2026-08-21T00:00:00.000Z",
    "shareScope": "world-only"
  },
  "worldId": "ash-harbor"
}
```

| 字段 | 校验 |
| --- | --- |
| `formatVersion` | 必须为整数；**主版本不等于实现所知版本即拒绝**（向前兼容靠加条目与小版本，不靠宽容解析） |
| `kind` | 必须为 `"world-bundle"` |
| `meta.title` | 非空字符串，≤ 200 字符。同名同格式在任何机器上都派生同一个书位（`sha1(title\|format)` 前 16 位），这是导入冲突检测的依据 |
| `meta.format` | `"txt"` 或 `"epub"`（来源格式仅作元信息） |
| `meta.chapterCount` | 0–5000 的整数，必须与 `chapter-index.json` 长度一致；带原文时还须与 `chapters.json` 长度一致 |
| `includes.chapters` / `includes.summaries` | 布尔值，必须与对应条目的实际存在性一致 |
| `includes.characterCache` | 整数，必须等于包内精读缓存条目数 |
| `provenance.schemaVersion` | 世界档案的推演书 schema 版本；**< 4 的旧档案拒绝导入**（请在原机器重起稿后再导出） |
| `provenance.appVersion` / `bakedModel` / `licenseNote` | 可选的溯源信息；`licenseNote` 由导出方填写授权声明（≤ 500 字） |
| `provenance.shareScope` | `"world-only"`（轻装档）或 `"with-source"`（全档），与 `includes` 一致 |
| `worldId` | 世界档案的 `world.id`，导入侧据此归位人物精读缓存目录 |

## 导入校验管线

兼容读取器应当复刻以下顺序（参考实现 `parseWorldBundle`）：

1. **容器预检**：白名单条目、逐条目解压体积累加（拿不到预估值即拒绝——fail-closed，
   同 EPUB 预检语义）。
2. **manifest 校验**：逐字段如上表。
3. **世界档案收口**（与起稿收尾同一条链，全部纯函数、零 LLM）：
   `normalizeWorld` → `migrateState`（初始状态先迁移，顺序与读档路径一致）→
   `diagnoseWorld` → 有错误则 `mechanicallyRepairWorld` 机械修复（去悬空引用、钳数值
   区间）→ 复诊后仍有**硬错误**（结构缺失、初始状态对不上）→ 拒绝导入 →
   `validateWorld` + `validateInitialState` 抛错型把关。
   - 软错误（悬空引用、越界数值）修掉后容忍；**不做**最小骨架降级——导入侧没有模型
     可救场，把别人分享的世界偷换成空壳比明着失败更糟。
4. 无原文档位导入后：`chapters` 为空数组落库，书库 `meta` 标 `sourceless: true`，
   章节目录随书落盘 `books/<id>/chapter-index.json`（`meta.chapterCount` 按目录章数落）；
   文风 BM25、「原著此刻」、正典账本、人物精读请求全部走既有的优雅回退路径
   （引擎对空 `sourceChapters` 本就逐点回退，有确定性测试兜底）。
5. **补挂原文**：读者自备原著（txt/epub）可把轻装档补成满血——导入侧按落盘的
   章节目录比对「同一本书」（章数与标题，`src/source-match.js`：match/loose 放行、
   mismatch 拒绝），比对过才把章节写进书位、摘掉 `sourceless`；随后跑一遍**定向
   粗读**（`bake({ coarseOnly: true })`：只烧摘要日志，不重建世界档案）落账本。
   文风范本、人物精读随 `sourceChapters` 就位自动恢复；账本走既有的懒加载路径。

## 版本化策略

- `formatVersion` 主版本 bump = 破坏性变更（旧实现必须拒绝新文件并提示升级）。
- 加条目、加可选字段走小版本；未知可选字段应忽略而不是拒绝。
- 世界档案自身的 `schemaVersion` 演进（当前 5）沿用推演书引擎的规则，随
  `provenance.schemaVersion` 透出。

## 实现边界

- 组包/解析/校验全部在 `src/world-bundle.js`（纯 Node，仅依赖 `jszip`），不 import
  Electron——书落库、对话框、缓存归位在 `electron/main.js` 的
  `library:export-world` / `library:import-world` / `library:import-world-confirm`
  三个 IPC 处理器里；补挂原文走 `library:attach-source` /
  `library:attach-source-confirm`（比对逻辑在 `src/source-match.js`，
  定向粗读是 `NovelBaker.bake` 的 `coarseOnly` 档）。
- 对局存档（progress v4）不在本格式内：它内嵌完整 world 且硬依赖书库原文，需要另立
  格式，暂不支持。

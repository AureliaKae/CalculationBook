// 结构化输出的函数调用工具定义(拍板:所有模型的结构化请求都走 function calling)。
// turn-schema.js 管回合/选项/弧线三个核心工具,这里管其余全部结构化调用:
// 客户端侧(校验/漂移/回顾/观察/开场/终章/草稿/修复)与烧制侧(摘要/风格/五片/修复/质检)。
// 语义约束仍在各层校验器兜底;这里的 Schema 负责让 API 层保证「结构合法」。

function tool(name, description, parameters) {
  return {
    type: "function",
    function: { name, description, parameters },
  };
}

/* ============ 客户端 · 回合期 ============ */

export function submitConsistencyTool() {
  return tool("submit_consistency", "提交身份一致校验结论:是否有实质违例及每条违例说明。", {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "没有实质违例时为 true。" },
      issues: {
        type: "array",
        description: "违例列表;ok 为 true 时给空数组。",
        items: {
          type: "object",
          properties: {
            where: { type: "string", enum: ["narrative", "options"] },
            text: { type: "string", description: "一句违例说明。" },
          },
          required: ["where", "text"],
        },
      },
    },
    required: ["ok", "issues"],
  });
}

export function submitDriftTool() {
  return tool("submit_drift", "提交弧线漂移判定:keep / adjust / replace 与一句理由。", {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["keep", "adjust", "replace"] },
      reason: { type: "string", description: "一句话理由。" },
    },
    required: ["verdict", "reason"],
  });
}

export function submitRetrospectiveTool() {
  return tool("submit_retrospective", "提交卷终回顾:15-30 字的一句话回望。", {
    type: "object",
    properties: {
      retrospective: { type: "string", description: "15-30 字的一句卷终回顾。" },
    },
    required: ["retrospective"],
  });
}

export function submitObservationTool() {
  return tool("submit_observation", "提交游戏节奏观察结论:只能改难度偏移、选项风味与叙事节奏三项。", {
    type: "object",
    properties: {
      difficultyBias: {
        type: "integer",
        minimum: -2,
        maximum: 2,
        description: "正=玩家太顺需要加压,负=玩家连连受挫需要减压,0 或省略=不动。",
      },
      optionFlavor: {
        type: "string",
        enum: ["dangerous", "cautious", "neutral"],
        description: "下一步选项的风格倾向。",
      },
      pacing: {
        type: "string",
        enum: ["faster", "slower", "neutral"],
        description: "叙事节奏倾向。",
      },
    },
  });
}

export function submitOpeningTool() {
  return tool("submit_opening", "提交互动小说开场叙事:300-500 字中文开场正文。", {
    type: "object",
    properties: {
      opening: { type: "string", description: "300-500 字中文开场正文。" },
    },
    required: ["opening"],
  });
}

export function submitEpilogueTool() {
  return tool("submit_epilogue", "提交命运终章叙事:500-900 字中文终章正文。", {
    type: "object",
    properties: {
      epilogue: { type: "string", description: "500-900 字中文终章正文。" },
    },
    required: ["epilogue"],
  });
}

export function submitDraftTool() {
  return tool("submit_draft", "提交世界观扩建的实体草稿与符合度自评。", {
    type: "object",
    properties: {
      draft: {
        type: "object",
        description: "实体草稿:name/summary(role 用 description)加引用字段(locationIds/factionIds/connections)。",
        additionalProperties: true,
      },
      worldviewNote: {
        type: "string",
        description: "一句话说明为什么符合原著、与哪些已知设定呼应。",
      },
    },
    required: ["draft", "worldviewNote"],
  });
}

export function submitRepairedTurnTool() {
  return tool("submit_repaired_turn", "提交修复后的完整回合数据对象:保留原字段,只修正错误说明指出的部分。", {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
}

/* ============ 烧制与记忆 ============ */

export function submitSummaryMergeTool() {
  return tool("submit_summary", "提交压缩合并后的章节摘要。", {
    type: "object",
    properties: {
      summary: { type: "string", description: "合并后的新摘要正文。" },
    },
    required: ["summary"],
  });
}

export function submitSummaryVerifyTool() {
  return tool("submit_summary_check", "提交摘要合并校验结论。", {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      reason: { type: "string", description: "不通过时的一句话原因。" },
    },
    required: ["ok"],
  });
}

// 远期梗概合并（记忆分层 2026-08-21）：中窗摘要折叠进远期 digest 用。
export function submitDigestMergeTool() {
  return tool("submit_digest", "提交合并后的远期梗概。", {
    type: "object",
    properties: {
      digest: { type: "string", description: "合并后的远期梗概正文。" },
    },
    required: ["digest"],
  });
}

export function submitGenreTool() {
  return tool("submit_genre", "提交小说题材分类。", {
    type: "object",
    properties: {
      genre: { type: "string", description: "题材分类,取自给定枚举。" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["genre", "confidence"],
  });
}

// 模型认知探针:烧制前只凭书名问模型「你了解这本书吗」,要求给出可验证的
// 具体专名(主角名/体系名/势力名)佐证——专名不足时客户端会降级,防冷门书自信胡编。
export function submitModelProbeTool() {
  return tool("submit_model_probe", "提交对这本书的认知自评与佐证专名。", {
    type: "object",
    properties: {
      familiarity: {
        type: "string",
        enum: ["known", "partial", "unknown"],
        description: "known=系统了解;partial=只有模糊印象;unknown=不认识。",
      },
      specifics: {
        type: "array",
        items: { type: "string" },
        description: "能凭记忆写出的具体专名:主角名、体系/境界名、势力名、地名等。拿不准的不要写。",
      },
      note: { type: "string", description: "一句话补充说明,可省略。" },
    },
    required: ["familiarity", "specifics"],
  });
}

// 模型认知参考提取:设定层知识(人物/体系/势力/地点),防剧透与系列隔离由提示词红线约束。
export function submitModelReferenceTool() {
  return tool("submit_model_reference", "提交对本书的设定层认知参考。", {
    type: "object",
    properties: {
      characters: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "人物名。" },
            role: { type: "string", description: "身份/职业。" },
            affiliation: { type: "string", description: "所属势力。" },
            note: { type: "string", description: "一句话设定层说明(性格/立场),不写剧情走向。" },
          },
          required: ["name"],
        },
      },
      system: { type: "string", description: "本书的体系/境界阶梯一句话概括;无体系写空串。" },
      factions: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            note: { type: "string", description: "一句话定位。" },
          },
          required: ["name"],
        },
      },
      locations: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            note: { type: "string", description: "一句话定位。" },
          },
          required: ["name"],
        },
      },
      notes: { type: "string", description: "其余设定层要点,一两句;不写剧情。" },
    },
    required: ["characters"],
  });
}

export function submitStyleTool() {
  return tool("submit_style", "提交写作风格分析。", {
    type: "object",
    properties: {
      narration: { type: "string", description: "人称与视角。" },
      tense: { type: "string", description: "时态。" },
      sentence: { type: "string", description: "句长与节奏。" },
      punctuation: { type: "string", description: "标点习惯。" },
      imagery: { type: "array", items: { type: "string" }, description: "常见意象数组。" },
      diction: { type: "array", items: { type: "string" }, description: "方言或专有词汇数组。" },
      chapterForm: { type: "string", description: "章节体例。" },
      avoid: { type: "array", items: { type: "string" }, description: "应当避免的写法数组。" },
    },
    required: ["narration", "tense", "sentence", "punctuation"],
  });
}

export function submitBatchExtractTool() {
  // 条数与长度上限是粗读的省钱闸:输出 token 单价通常是输入的好几倍,
  // 而下游 digestCoarse/正典账本都会再裁剪——多产出的部分纯属白烧。
  const cappedList = (label) => ({
    type: "array",
    maxItems: 12,
    description: `至多 12 条，只挑本片段最重要的${label}，每条一句话。`,
    items: { type: "object", additionalProperties: true },
  });
  return tool("submit_batch_extract", "提交小说片段的粗读提取:角色、地点、势力、关键事件与事实。", {
    type: "object",
    properties: {
      characters: cappedList("角色"),
      locations: cappedList("地点"),
      factions: cappedList("势力"),
      events: cappedList("关键事件"),
      facts: cappedList("事实"),
      summary: { type: "string", description: "本片段主线摘要，三百字以内。" },
    },
    additionalProperties: true,
  });
}

export function submitFocusDetailTool() {
  return tool("submit_focus_detail", "提交切入点附近章节的精读补充:场景、人物当时状态与可玩的冲突。", {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
}

export function submitSkeletonTool() {
  return tool("submit_skeleton", "提交世界骨架:id/title/summary/locations/attributes/traits/stats。", {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      locations: { type: "array", items: { type: "object", additionalProperties: true } },
      attributes: { type: "array", items: { type: "object", additionalProperties: true } },
      traits: { type: "array", items: { type: "object", additionalProperties: true } },
      stats: { type: "array", items: { type: "object", additionalProperties: true } },
      rules: { type: "object", additionalProperties: true },
    },
    required: ["id", "title", "summary", "locations", "attributes", "traits", "stats"],
  });
}

export function submitPeopleTool() {
  return tool("submit_people", "提交人物与身份片:characters/factions/roleTemplates/roleProgression/povCharacters。", {
    type: "object",
    properties: {
      characters: { type: "array", items: { type: "object", additionalProperties: true } },
      factions: { type: "array", items: { type: "object", additionalProperties: true } },
      roleTemplates: { type: "array", items: { type: "object", additionalProperties: true } },
      roleProgression: { type: "array", items: { type: "object", additionalProperties: true } },
      povCharacters: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        description: "原著叙事 POV(视角主角)的 character id 清单:单线书 1 人,双 POV/多线书按线 1-3 人。",
        items: { type: "string" },
      },
    },
    required: ["characters", "factions", "roleTemplates", "roleProgression"],
  });
}

export function submitItemsTool() {
  return tool("submit_items", "提交世界补全物品清单。", {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["items"],
  });
}

export function submitThreadsTool() {
  return tool("submit_threads", "提交时间线与事实:timeline/facts。", {
    type: "object",
    properties: {
      timeline: { type: "array", items: { type: "object", additionalProperties: true } },
      facts: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["timeline", "facts"],
  });
}

export function submitCatalogTool() {
  return tool("submit_catalog", "提交创角目录:creationCatalog/creationFields。", {
    type: "object",
    properties: {
      creationCatalog: { type: "object", additionalProperties: true },
      creationFields: { type: "array", items: { type: ["object", "string"] } },
    },
    required: ["creationCatalog"],
  });
}

export function submitWorldRepairTool() {
  return tool("submit_world_repair", "提交修复后的完整世界档案 JSON。", {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
}

export function submitCatalogCoherenceTool() {
  return tool("submit_catalog_coherence", "提交创角目录质检结论:需要删除的近义重复词条 id。", {
    type: "object",
    properties: {
      removeIds: { type: "array", items: { type: "string" } },
    },
    required: ["removeIds"],
  });
}

export function submitCharacterDetailTool() {
  return tool("submit_character_detail", "提交原著人物的精读档案。", {
    type: "object",
    properties: {
      role: { type: "string", description: "身份。" },
      summary: { type: "string", description: "当前处境。" },
      motives: { type: "array", items: { type: "string" }, description: "动机数组。" },
      habits: { type: "array", items: { type: "string" }, description: "行为习惯数组。" },
      resources: { type: "array", items: { type: "string" }, description: "资源数组。" },
      constraints: { type: "array", items: { type: "string" }, description: "限制数组。" },
      secrets: { type: "array", items: { type: "string" }, description: "已出现的秘密数组。" },
    },
    required: ["role", "summary"],
  });
}

// 人物状态记账（拍板 2026-08-20：连贯性修复——人物状态追踪）：快模型把
// 「静态人物卡 + 近期演出」压缩成每人的此刻状态笔记，注入人物条目的
// currentState，治「档案对但人物在游玩里漂移」。
export function submitEntityStatesTool() {
  return tool("submit_entity_states", "提交人物当前状态笔记。", {
    type: "object",
    properties: {
      states: {
        type: "array",
        items: {
          type: "object",
          properties: {
            characterId: { type: "string", description: "输入清单里的人物 id，照抄。" },
            note: {
              type: "string",
              description: "此刻状态笔记，≤50 字：处境、动向、与玩家相关的最近变化。不得编造输入里没有的事。",
            },
          },
          required: ["characterId", "note"],
        },
      },
    },
    required: ["states"],
  });
}

export function submitUpgradeWorldTool() {
  return tool("submit_upgrade_world", "提交旧世界档案的补齐:四个集合。", {
    type: "object",
    properties: {
      factions: { type: "array", items: { type: "object", additionalProperties: true } },
      roleTemplates: { type: "array", items: { type: "object", additionalProperties: true } },
      locations: { type: "array", items: { type: "object", additionalProperties: true } },
      characters: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["factions", "roleTemplates", "locations", "characters"],
  });
}

export function submitRoleAbilitiesTool() {
  return tool("submit_role_abilities", "提交身份能力补写清单。", {
    type: "object",
    properties: {
      roles: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["roles"],
  });
}

export function submitTimelineFactsTool() {
  return tool("submit_timeline_facts", "提交时间线事实变化补写清单。", {
    type: "object",
    properties: {
      timeline: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["timeline"],
  });
}

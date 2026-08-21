// 回合结构化数据的函数调用定义。
// 之前结构请求用 json_object 让模型「自由拼复杂 JSON」，字段缺失、非法 JSON、
// options 丢失等违约会随机发生。改成 function calling 后，结构由 API 层根据
// 这份 JSON Schema 强制生成：options 必为数组且 2-10 项、delta 必为对象、
// risk/approach 必须落在枚举内。语义约束（ID 是否存在、axis 是否唯一含 exit 等）
// 仍由 validateResponse 兜底。

export const SUBMIT_TURN_FUNCTION = {
  name: "submit_turn",
  description:
    "提交本回合文字生存小说的结构化数据：状态数值变化(delta)、可选的地点/章节/伏笔状态补丁、关系与人物变化、系统补丁、新伏笔与检索词，以及命运偏离补丁(divergencePatch)、替代事件(replacementEvent)与涌现故事补丁(emergentPatch)。options 仅交锋回合输出（见系统提示词的交锋条款），普通回合由玩家意图另行生成，不在此提交。",
  parameters: {
    type: "object",
    properties: {
      delta: {
        type: "object",
        description: "属性值的相对变化量，键是数值 stat id，值是与当前值相加的数字变化量。",
        additionalProperties: { type: "number" },
      },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        description: "交锋回合的 2-4 个搏杀行动选项；普通回合不输出此字段。",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string", description: "用原著语气写成的可执行行动，以具体动词开头。" },
            axis: {
              type: "string",
              enum: ["investigate", "social", "force", "exit"],
              description: "行动轴:investigate=查探求证,social=周旋往来,force=动手用强,exit=观望/忍耐/拒绝/脱离。",
            },
            approach: {
              type: "string",
              enum: ["cooperate", "persuade", "deceive", "threaten", "resist", "avoid"],
            },
            risk: { type: "string", enum: ["safe", "risky", "dire"] },
            attribute: { type: "string", description: "参与判定的属性 id。" },
            timeCost: { type: "number", minimum: 0, description: "行动消耗的分钟数，不展示给玩家。" },
            target: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["character", "faction"] },
                id: { type: "string" },
              },
            },
            requirements: {
              type: "object",
              description: "行动的可用性前置条件。合法字段:locationId(当前地点)、roleIds(限某身份)、factionId(需成员身份)、authority(需职权:command/manage/inspect)、traits(需身份蕴含的特质 id,引用 context.playerCapabilities.traitIds)、resourceId(消耗资源)。性格门控已取消(选项即意图),不得使用任何人格维度作为前置条件。只在行动确实依赖时填写。",
              properties: {
                locationId: { type: "string" },
                roleIds: { type: "array", items: { type: "string" } },
                factionId: { type: "string" },
                authority: { type: "array", items: { type: "string", enum: ["command", "manage", "inspect"] } },
                traits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                  },
                },
                resourceId: { type: "string" },
              },
            },
            stakes: { type: "string", description: "可预见的代价预告。" },
            bigFiveShift: {
              type: "object",
              description: "玩家选择该行动后其大五人格的漂移量。键为 openness/conscientiousness/extraversion/agreeableness/neuroticism,值为 -5 到 5 的整数:普通行动 ±1~3 温和漂移;与角色一路走来的性子明显相悖的极端选择用 ±4~5 的大漂移——极端处境下的选择是性格转折点;exit 观望/等待类行动通常为 0 或省略。只在行动确实会塑造心性时填写。",
              properties: {
                openness: { type: "number", minimum: -5, maximum: 5 },
                conscientiousness: { type: "number", minimum: -5, maximum: 5 },
                extraversion: { type: "number", minimum: -5, maximum: 5 },
                agreeableness: { type: "number", minimum: -5, maximum: 5 },
                neuroticism: { type: "number", minimum: -5, maximum: 5 },
              },
            },
            divergence: {
              type: "object",
              description: "改命行动的声明：目标与是否发动最终改写。硬前提（时间/地点/人物）未满足时不得生成。",
              properties: {
                targetId: { type: "string" },
                targetType: { type: "string", enum: ["timeline", "fact", "entity"] },
                fire: { type: "boolean" },
              },
            },
          },
          required: ["id", "text", "axis", "risk", "attribute"],
        },
      },
      statePatch: {
        type: "object",
        description: "玩家移动或伏笔解决时使用的状态补丁。章节位置由系统按原文时间推演,不需要也不允许写。",
        properties: {
          locationId: { type: "string" },
          resolvedThreads: { type: "array", items: { type: "string" } },
        },
      },
      jumpMinutes: {
        type: "integer",
        minimum: 0,
        maximum: 43200,
        description:
          "只有本回合实际演出了跨越数天/数月的时间跳跃(闭关、远行、昏迷、押送等)才输出的正整数分钟,最长 30 天;分钟数必须与正文写出的流逝等量(「几日/数日」按 3 日=4320 计),以 context.storyClock 为起点估算;普通回合省略。",
      },
      evolutionPatch: {
        type: "object",
        description: "本回合直接影响的关系与人物状态变化。",
        properties: {
          relationships: { type: "array" },
          entities: { type: "array" },
          discoveredCharacterIds: { type: "array", items: { type: "string" } },
        },
      },
      systemPatches: {
        type: "object",
        description: "为 dominantSystems 中的系统输出的详细补丁。",
      },
      openThreads: { type: "array", items: { type: "string" } },
      retrievalKeywords: { type: "array", items: { type: "string" } },
      beatAdvance: {
        type: "boolean",
        description:
          "弧线节拍推进声明(可选):仅当 context.arcBeat 存在、且本回合叙事已实质达成或落空该节拍的戏剧目标(aim)时输出 true;否则省略。代码会硬性防止同一节拍滞留过久,不必为推进而推进。",
      },
      clashStart: {
        type: ["object", "null"],
        description: "只有已知且敌意明确的人物主动动手时才输出，否则省略。",
        properties: {
          opponentId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["opponentId"],
      },
      divergencePatch: {
        type: ["object", "null"],
        description:
          "命运偏离补丁：当玩家试图在原著没讲清的地方改变既定命运（人物生死/关键事件/新增分支）时输出。只有硬前提（时间/地点/人物在场存活）已满足时才可输出；fire 为 true 表示发动最终改写，否则为铺垫。",
        properties: {
          targetId: { type: "string", description: "被改写的目标 id（timeline 事件 / fact / 原著人物）。" },
          targetType: { type: "string", enum: ["timeline", "fact", "entity"] },
          fire: { type: "boolean", description: "是否发动最终改写判定。" },
          override: {
            type: "object",
            properties: {
              text: { type: "string", description: "改写后的当前事实文本，符合原著语气。" },
            },
          },
          evidence: { type: "string", description: "支撑这次改写的因果链/凭据。" },
        },
        required: ["targetId", "targetType"],
      },
      replacementEvent: {
        type: ["object", "null"],
        description:
          "替代事件：仅当本回合叙事实际演出了「被改写的命运引发的替代走向」（原定之事不再发生、局势改向新的可能）时输出；其余回合省略。time 必须是本回合之后的故事内时间，引用只能指向已存在的地点/事件/事实 id。replacesIds 填这条替代走向顶替的原著事件 id（context.timeline 里不再发生的原著条目）——它们从此作废，时间线由本事件直接代替，不留多余旧事；没有明确顶替对象时省略。",
        properties: {
          time: { type: "number", minimum: 0, description: "故事内发生时间（分钟数），必须晚于当前世界时间。" },
          text: { type: "string", description: "替代走向的一句话事件描述，用原著语气。" },
          locationId: { type: "string", description: "发生地点 id，必须是已存在的地点。" },
          tier: { type: "string", enum: ["core", "side", "local"], description: "命运层级，默认 side。" },
          prerequisites: { type: "array", items: { type: "string" }, description: "先决事件 id 数组。" },
          invalidatedBy: { type: "array", items: { type: "string" }, description: "被哪些事件解决后失效。" },
          replacesIds: { type: "array", items: { type: "string" }, description: "本替代走向顶替的原著事件 id 数组——这些旧事不再发生，时间线直接换线。" },
          resolution: { type: "string", enum: ["player_action", "world_time", "system_patch", "never"], description: "解决方式，默认 never。" },
          resolutionTargetIds: { type: "array", items: { type: "string" } },
          factsToAdd: { type: "array", description: "发生后成为真的事实（每项含 id/text/chapterAnchor）。" },
          factsToInvalidate: { type: "array", items: { type: "string" }, description: "发生后不再真的事实 id 数组。" },
        },
        required: ["time", "text"],
      },
      roleTransition: {
        type: ["object", "null"],
        description:
          "身份进阶声明：仅当本回合叙事实际演出了 context.roleProgression 中某条路径的触发事件、该路径前提已满足且未被使用/拒绝时输出；其余回合省略。",
        properties: {
          progressionId: { type: "string", description: "触发的进阶路径 id。" },
          triggerEventId: { type: "string", description: "本回合实际演出的触发事件 id。" },
        },
        required: ["progressionId", "triggerEventId"],
      },
      inventoryPatch: {
        type: ["object", "null"],
        description:
          "行囊补丁（拍板 2026-08-19：具名行囊）：本回合叙事实际演出了物品易手才输出——拾获/购得/赠予/缴获=gain，用掉/丢失/被夺/损毁=lose；没有演出易手就省略，禁止凭空掉落。物品优先引用 context.world.items 已有 id（名字以目录为准），原著没写的新物件可自拟 name。行囊里的东西是行动素材（有剑才能舞剑、有丹才敢赴死战），选项与叙事不得虚构囊中没有的东西；已在囊中的物品不重复入囊。",
        properties: {
          changes: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["gain", "lose"] },
                itemId: { type: "string", description: "烧制物品目录里的 id（有则填，名字以目录为准）。" },
                name: { type: "string", description: "物品名（2-16 字）。" },
                note: { type: "string", description: "一句来历/用途（≤40 字），目录物品可省略。" },
              },
              required: ["action", "name"],
            },
          },
        },
        required: ["changes"],
      },
      learnedAbilities: {
        type: "array",
        maxItems: 2,
        description:
          "技能习得（拍板 2026-08-19：习得制）：本回合叙事实际演出了学会新本事——拜师受教、悟道开窍、苦练有成、获得传承——才输出；每条一句「能做什么」（≤40 字，须与当前境界相符），每回合至多 2 条；没有习得契机的回合省略，禁止无因习得。习得的技能与身份能力（capabilities.abilities）合并生效，永久跟随玩家。",
        items: { type: "string" },
      },
      realmBreakthrough: {
        type: ["object", "null"],
        description:
          "境界突破（拍板 2026-08-19：独立于身份进阶）：仅当本回合叙事实际演出了境界突破的契机——闭关圆满、丹成药就、生死感悟、点化开窍——且 context.playerCapabilities.realmTraits 阶梯里存在比当前更高的阶时输出；其余回合省略。突破必须付出代价（时间流逝/资源耗用/生死风险）且逐阶而上，不得跳级顿悟；突破后境界不再随身份进阶倒退。",
        properties: {
          toTraitId: { type: "string", description: "突破到的境界 trait id（原著阶梯里的更高一阶）。" },
          note: { type: "string", description: "突破契机一句话（≤40 字），进角色卡履历。" },
        },
        required: ["toTraitId"],
      },
      emergentPatch: {
        type: ["object", "null"],
        description:
          "涌现故事补丁（可选）：当本回合叙事在原著没写到的地方实际演出了玩家行动引出的新东西时输出——新故事线（newStories）、新人物（newCharacters）、该故事线的后续事件（newEvents）、或本回合行动实质推进了 context.emergentStories 中的既有故事线（storyImpacts）。涌现必须由玩家行动直接导致，禁止无因涌现；叙事没有演出就不得输出；每类最多 1 条，宁缺毋滥；其余回合省略。影响力动量由代码累计：故事长到足够大时，有几率升格为影响整个世界的核心事件。",
        properties: {
          newStories: {
            type: "array",
            maxItems: 1,
            description: "本回合诞生的原创故事线；玩家持续经营的营生（铺面/门派/商队/耳目）用 kind=venture 登记为基业线。",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "故事线名（基业即字号/山门名），2-12 字，原著语气（如「青蚨钱庄之局」「孤山新盗」）。",
                },
                summary: {
                  type: "string",
                  description: "一句梗概：这条故事线是什么、因何而起（≤80 字）。",
                },
                kind: {
                  type: "string",
                  enum: ["tale", "venture"],
                  description: "tale=一段恩怨际遇的故事线（默认）；venture=玩家自己经营生长的基业线。",
                },
              },
              required: ["title", "summary"],
            },
          },
          newCharacters: {
            type: "array",
            maxItems: 1,
            description: "玩家行动直接引出的新人物（新收的随从、名声招来的人等）。",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "姓名，2-8 字，不得包含任何原著人物姓名或主角/反派等标签。" },
                role: { type: "string", description: "身份称呼一句（如「游方郎中」「落拓刀客」）。" },
                summary: { type: "string", description: "一句人物简介：来历、与玩家的因果（≤120 字）。" },
                locationId: { type: "string", description: "其所在地点 id，必须是已存在的地点。" },
                factionId: { type: "string", description: "所属势力 id（若有），必须是已存在的势力。" },
              },
              required: ["name", "summary", "locationId"],
            },
          },
          newEvents: {
            type: "array",
            maxItems: 1,
            description: "本回合演出的涌现走向的事件化：这条故事线接下来的一个既定事件。",
            items: {
              type: "object",
              properties: {
                time: { type: "number", minimum: 0, description: "故事内发生时间（分钟数），必须晚于当前世界时间。" },
                text: { type: "string", description: "一句话事件描述，原著语气。" },
                locationId: { type: "string", description: "发生地点 id，必须是已存在的地点。" },
                tier: { type: "string", enum: ["core", "side", "local"], description: "命运层级，默认 local。" },
              },
              required: ["time", "text", "locationId"],
            },
          },
          storyImpacts: {
            type: "array",
            maxItems: 3,
            description: "本回合玩家行动对既有涌现故事线（含基业线）的实质推进。",
            items: {
              type: "object",
              properties: {
                storyId: { type: "string", description: "context.emergentStories 中的故事 id。" },
                weight: {
                  type: "integer",
                  minimum: 0,
                  maximum: 2,
                  description: "推进力度：1=顺带推进，2=实质推进（本回合的主要后果之一）。",
                },
              },
              required: ["storyId", "weight"],
            },
          },
          companionJoin: {
            type: ["object", "null"],
            description:
              "同行者入队声明（可选）：仅当本回合叙事实际演出了一位涌现人物（context.world.characters 里 provenance 为 emergent 的人物）决意随行、与玩家结伴同走时输出；原著人物不得入队；队伍上限 3 人，队满时不输出。其余回合省略。",
            properties: {
              characterId: { type: "string", description: "入队的涌现人物 id。" },
            },
            required: ["characterId"],
          },
          companionLeave: {
            type: ["object", "null"],
            description:
              "同行者离队声明（可选）：仅当本回合叙事实际演出了同行者离队、身故或背叛时输出；其余回合省略。",
            properties: {
              characterId: { type: "string", description: "离队的同行者 characterId。" },
              reason: { type: "string", description: "一句离队缘由（≤60 字）。" },
            },
            required: ["characterId"],
          },
        },
      },
    },
    required: ["delta"],
  },
};

export function submitTurnTool() {
  return {
    type: "function",
    function: SUBMIT_TURN_FUNCTION,
  };
}

// 意图先行(拍板 R3):只重生成「下一步行动选项」的轻量函数调用——
// 玩家声明方向后围绕意图产出 options,不要求 delta 等回合数据。
// 选项 schema 与回合协议完全一致,复用同一份定义。
const SUBMIT_OPTIONS_FUNCTION = {
  name: "submit_options",
  description:
    "围绕玩家声明的意图生成当前处境下的 2-10 个行动选项：只提交 options，不包含任何回合结算数据。",
  parameters: {
    type: "object",
    properties: {
      options: SUBMIT_TURN_FUNCTION.parameters.properties.options,
    },
    required: ["options"],
  },
};

export function submitOptionsTool() {
  return {
    type: "function",
    function: SUBMIT_OPTIONS_FUNCTION,
  };
}

// 弧线导演(拍板:剧情层叠加):围绕玩家意图规划一条多回合剧情弧。
// 规划是低频调用(一次服务 5-10 回合),走强槽;产出由 director.sanitizeArc 净化。
const SUBMIT_ARC_FUNCTION = {
  name: "submit_arc",
  description:
    "作为戏剧导演,围绕玩家的志向与谋算规划接下来 5-10 回合的剧情弧:一段前提与 4-6 个节拍(铺垫/障碍/转折/收束),每个节拍一句戏剧目标。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "卷名,2-12 字,原著语气(如「雨夜容城」「借刀之约」)。只用于收束后的回望,不会出现在正文里。",
      },
      premise: {
        type: "string",
        description: "这段弧线的一句总纲:玩家要什么、什么在拦着(≤80 字)。方向必须是玩家志向的方向——障碍可以加,方向不可改(导演设障)。",
      },
      beats: {
        type: "array",
        minItems: 4,
        maxItems: 6,
        description: "4-6 个节拍,末个必须是 resolution。每个节拍一句戏剧目标(aim,≤60 字):这一段戏要让局面发生什么变化。",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["setup", "obstacle", "turn", "resolution"] },
            aim: { type: "string", description: "本节拍的戏剧目标一句:具体的局面变化,不是抽象主题。" },
          },
          required: ["kind", "aim"],
        },
      },
      plannedTurns: {
        type: "integer",
        minimum: 5,
        maximum: 10,
        description: "这条弧线预计服务的回合数,5-10。",
      },
    },
    required: ["title", "premise", "beats"],
  },
};

export function submitArcTool() {
  return {
    type: "function",
    function: SUBMIT_ARC_FUNCTION,
  };
}

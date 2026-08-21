const AXES = ["investigate", "social", "force", "exit"];
const RISKS = ["safe", "risky", "dire", "safe"];

function getDelta(turn) {
  if (turn === 10) {
    return { breath: -10 };
  }

  if (turn % 2 === 0) {
    return { clue: 1 };
  }

  return {};
}

export class MockLlm {
  narrativeFor({ context, check }) {
    const turn = context.state.turn;
    const eventText = context.dueEvents
      .map((event) =>
        event.delivery === "present"
          ? `你亲眼卷入了${event.text}。`
          : `远处传来了关于${event.text}的传闻。`,
      )
      .join("");
    const clueText = turn === 2 ? "你在裂缝里摸到半枚刻着燕尾的铜扣。" : "";
    const remembered = context.unresolvedThreads.includes("燕尾铜扣")
      ? "那半枚燕尾铜扣的冰凉触感仍压在记忆里。"
      : "";
    const consequence = check.result.includes("failure") ? "行动留下了代价。" : "局面向你松开了一线。";

    return `第${turn}夜。${eventText}${clueText}${remembered}${consequence}`;
  }

  structureFor({ context, check, attempt }) {
    const turn = context.state.turn;
    return {
      delta: getDelta(turn),
      statePatch: {},
      options: AXES.map((axis, index) => ({
        id: `turn-${turn}-${index}`,
        text:
          axis === "exit"
            ? "退到阴影中等待局势变化"
            : `从${axis}方向处理眼前局面`,
        axis,
        approach: axis === "social" ? "persuade" : axis === "exit" ? "avoid" : "resist",
        risk: RISKS[index],
        attribute: index % 2 === 0 ? "resolve" : "agility",
      })),
      openThreads: turn >= 2 ? ["燕尾铜扣"] : [],
      retrievalKeywords: turn >= 2 ? ["燕尾", "铜扣"] : [],
      // 弧线导演:偶数回合声明节拍推进,测试据此驱动整条弧线的收束与重规划。
      ...(context.arcBeat && turn % 2 === 0 ? { beatAdvance: true } : {}),
      attempt,
    };
  }

  // 双请求协议：叙事与结构分开返回。
  async generateStory(args) {
    return { narrative: this.narrativeFor(args), transportTimings: {} };
  }

  async generateStructure(args) {
    // 意图先行:记录结构请求收到的意图,测试断言用。
    this.lastStructureIntent = args.intent ?? "";
    return this.structureFor(args);
  }

  // 意图重生成选项:返回两条围绕意图的合法选项(含 exit)。
  async generateIntentOptions({ context, intent }) {
    this.lastIntentOptionsIntent = intent ?? "";
    return [
      {
        id: `intent-${context.state.turn}-investigate`,
        text: `围绕「${intent || "眼下的局面"}」打探线索`,
        axis: "investigate",
        approach: "resist",
        risk: "safe",
        attribute: "resolve",
      },
      {
        id: `intent-${context.state.turn}-exit`,
        text: "退到阴影中等待局势变化",
        axis: "exit",
        approach: "avoid",
        risk: "safe",
        attribute: "agility",
      },
    ];
  }

  // 弧线导演(mock):固定四节拍弧线,调用计数供测试断言规划/漂移/回顾的触发时机。
  async generateArcPlan() {
    this.arcPlans = (this.arcPlans ?? 0) + 1;
    return {
      title: "雨夜燕尾",
      premise: "玩家要在燕尾巷立足，地头蛇不肯。",
      plannedTurns: 5,
      beats: [
        { kind: "setup", aim: "燕尾巷的规矩摆到玩家面前" },
        { kind: "obstacle", aim: "地头蛇给玩家下马威" },
        { kind: "turn", aim: "地头蛇的把柄落到玩家手里" },
        { kind: "resolution", aim: "燕尾巷的地界重新划过" },
      ],
    };
  }

  async checkArcDrift() {
    this.arcDriftChecks = (this.arcDriftChecks ?? 0) + 1;
    return { verdict: "keep", reason: "mock 恒 keep" };
  }

  async generateArcRetrospective({ arc }) {
    this.arcRetrospectives = (this.arcRetrospectives ?? 0) + 1;
    return { retrospective: `${arc?.title ?? "这一卷"}的事了结。` };
  }

  // 身份一致校验:mock 环境恒通过(引擎测试单独用自定义 llm 覆盖违例路径)。
  async checkIdentityConsistency() {
    return { ok: true, issues: [] };
  }

  // 旧单请求接口保留：存量测试与模拟脚本仍在使用。
  async generate({ context, check, attempt }) {
    return {
      narrative: this.narrativeFor({ context, check }),
      ...this.structureFor({ context, check, attempt }),
    };
  }
}

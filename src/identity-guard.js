// 身份/外貌/细节的「绑定原著人物」判定:玩家永远是原著里不存在的新角色,
// 身份目录只能收录通用来路,身外字段选项不得点名原著人物(称谓已取消)。
// 本模块零依赖,主进程、引擎与渲染层共用同一套判定。

const CHARACTER_BOUND_BLOCKLIST = [
  "主角",
  "配角",
  "反派",
  "男主",
  "女主",
  "男主角",
  "女主角",
];

export function characterNamesOf(world) {
  return new Set(
    (Array.isArray(world?.characters) ? world.characters : [])
      .map((character) => String(character?.name ?? "").trim())
      .filter((name) => name.length >= 2),
  );
}

// 紧随人名之后的连接成分：人名 + 这些词才构成「绑定某人的关系身份」。
const RELATIONAL_FOLLOWERS =
  /^(?:的|之|道侣|同伴|师弟|师兄|师姐|师妹|师父|师傅|师尊|徒弟|弟子|妻子|夫君|之子|之女|旧识|好友|亲随|手下|部下|门下|麾下|帐下|护卫|随从|书童|侍女)/;

// 名称是否绑定某个原著具体人物:命中叙述标签(主角/配角/反派……),
// 或包含任一原著人物姓名(如「韩立道侣」「厉飞雨同伴」)。
export function isCharacterBoundName(name, characterNames) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return false;
  if (CHARACTER_BOUND_BLOCKLIST.includes(trimmed)) return true;
  return [...characterNames].some((characterName) => trimmed.includes(characterName));
}

// 身份目录条目专用判定：目录会被静默过滤且没有恢复路径，判据必须比通用包含
// 更紧——只认「整体即人名」或「人名后紧跟关系连接词」。纯子串匹配会把
// 「云梦泽弟子」这类与人名（云梦）撞前缀的 地名/门派 来路误杀成绑定身份，
// 目录凭空少一条合法条目。
export function isCharacterBoundRoleName(name, characterNames) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return false;
  if (CHARACTER_BOUND_BLOCKLIST.includes(trimmed)) return true;
  for (const characterName of characterNames) {
    if (trimmed === characterName) return true;
    const at = trimmed.indexOf(characterName);
    if (at >= 0 && RELATIONAL_FOLLOWERS.test(trimmed.slice(at + characterName.length))) {
      return true;
    }
  }
  return false;
}

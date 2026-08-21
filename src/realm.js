// 境界阶梯的统一识别模块(拍板 2026-08-19:境界可独立突破):evolution、
// role-identity、gameplay-systems、engine 都要用阶梯判定,抽成叶子模块
// 避免互相循环依赖(evolution ↔ role-identity 的老问题)。

// 境界阶梯:书里非数值的境界类特质(练气/筑基/元婴…),烘焙生成顺序即阶梯顺序。
// 阶梯每一阶应是一个独立 trait(烧制提示词要求),识别先看境界类关键词,再看
// 阶名后缀(炼气期/结丹期这类名字本身不含关键词)。名称不带后缀的普通设定
// (宗门职位等)不会误入阶梯。
const REALM_TRAIT_PATTERN =
  /境界|阶梯|修为|等级|品阶|阶位|段位|道行|斗气|魂力|星阶|内力|武功|化神|元婴|金丹|筑基|练气|炼气|结丹|炼虚|合体|大乘|渡劫|飞升/;
const REALM_NAME_SUFFIX_PATTERN = /(?:期|境|阶|级|段|重)$/;

export function realmTraitsOf(world) {
  // world 可能为 null（渲染层建角弹窗未开书时也会调用）：容忍空世界。
  return (world?.traits ?? []).filter((trait) => {
    const name = String(trait.name ?? "");
    const description = String(trait.description ?? "");
    return (
      REALM_TRAIT_PATTERN.test(`${name}${description}`) ||
      REALM_NAME_SUFFIX_PATTERN.test(name)
    );
  });
}

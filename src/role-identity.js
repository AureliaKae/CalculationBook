// 身份能力知识的统一落地模块:evolution 与 gameplay-systems 互相引用,
// 共享逻辑放这里避免循环依赖。
//
// 身份携带的四样东西在玩家身上各有一份镜像:
//   abilities  → player.abilities(叙事/选项的能力词汇来源)
//   traitIds   → player.traitIds(引擎硬执行「低微身份不可用高境界能力」的门槛)
//   authority  → 当前势力成员记录的 authority(职权行动与势力修正)
//   statMods/attributeMods → 只影响创角初始值(进阶走路径 modifiers,此处不碰)

import { realmTraitsOf } from "./realm.js";

// 职权白名单:command=调遣人手、manage=调用资源、inspect=查阅卷宗名册。
export const AUTHORITY_VALUES = Object.freeze(["command", "manage", "inspect"]);

// 把身份的能力知识落到玩家与成员记录上。创角、身份进阶、身份重选三条路径
// 都调用它,保证「身份变了,能力立刻跟着变」。数值 mods 不在此处应用。
export function applyRoleIdentity(state, role, world) {
  if (!state?.player || !role) return state;
  const player = state.player;
  player.abilities = Array.isArray(role.abilities)
    ? role.abilities.map(String).filter(Boolean)
    : [];
  let traitIds = (role.traitIds ?? []).filter((id) =>
    world.traits.some((trait) => trait.id === id),
  );
  // 境界突破不随身份进阶倒退(拍板 2026-08-19:修为是玩家自己修到的):
  // 换身份时保留已修到的高于新身份惯常境界的阶——低身份新来路,修为仍在身。
  const ladder = realmTraitsOf(world);
  if (ladder.length) {
    const realmIds = new Set(ladder.map((trait) => trait.id));
    const currentRealmId = (player.traitIds ?? []).find((id) => realmIds.has(id));
    const roleRealmId = traitIds.find((id) => realmIds.has(id));
    if (currentRealmId && roleRealmId && currentRealmId !== roleRealmId) {
      const currentRank = ladder.findIndex((trait) => trait.id === currentRealmId);
      const roleRank = ladder.findIndex((trait) => trait.id === roleRealmId);
      if (currentRank > roleRank) {
        // 只留玩家已修到的那一阶——同一身不能同时挂两阶境界。
        traitIds = [currentRealmId, ...traitIds.filter((id) => !realmIds.has(id))];
      }
    }
  }
  player.traitIds = traitIds;
  const membership = (state.factionMemberships ?? []).find(
    (item) => item.factionId === player.factionId,
  );
  if (membership) {
    membership.authority = (role.authority ?? []).filter((permission) =>
      AUTHORITY_VALUES.includes(permission),
    );
  }
  return state;
}

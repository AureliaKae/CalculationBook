import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorld } from "../src/evolution.js";
import {
  buildCreationDraftMessages,
  createEntity,
  CREATABLE_KINDS,
  playerCreationsView,
  seedCreatedCharacter,
  uniqueEntityId,
  validateCreation,
} from "../src/world-creation.js";

const base = normalizeWorld({
  id: "world",
  title: "书",
  characters: [{ id: "guide", name: "引路人", locationIds: ["gate"], firstChapter: 2 }],
  locations: ["gate", "tower"],
  factions: [{ id: "guild", name: "公会" }],
  roleTemplates: [{ id: "scout", name: "斥候", locationIds: ["gate"], factionIds: ["guild"] }],
  attributes: [{ id: "focus", name: "专注", initial: 20 }],
  stats: [{ id: "life", name: "生命", role: "vital", min: 0, max: 10, initial: 10 }],
  timeline: [],
  facts: [],
});

test("normalizeWorld stamps canon provenance and adds empty items by default", () => {
  assert.equal(base.factions[0].provenance.source, "canon");
  assert.equal(base.characters[0].provenance.source, "canon");
  assert.equal(base.locations[0].provenance.source, "canon");
  assert.equal(base.roleTemplates[0].provenance.source, "canon");
  assert.deepEqual(base.items, []);
});

test("createEntity writes a player-created faction with provenance", () => {
  const next = createEntity(
    "faction",
    { name: "听雨阁", summary: "盘踞在旧码头的散修结社", locationIds: ["gate"] },
    base,
    { lifeIndex: 2, createdTurn: 5 },
  );
  const faction = next.factions.at(-1);
  assert.equal(faction.name, "听雨阁");
  assert.equal(faction.provenance.source, "player_created");
  assert.equal(faction.provenance.lifeIndex, 2);
  assert.equal(faction.provenance.createdTurn, 5);
  // 原世界未被原地修改。
  assert.equal(base.factions.length, 1);
});

test("uniqueEntityId avoids collision by suffixing", () => {
  const id = uniqueEntityId("faction", { name: "guild" }, base);
  assert.notEqual(id, "guild");
  assert.ok(id.startsWith("guild"));
});

test("validateCreation rejects unknown references and missing fields", () => {
  const missing = validateCreation("faction", { name: "" }, base);
  assert.equal(missing.ok, false);

  const badRef = validateCreation(
    "role",
    { name: "客卿", description: "外聘的散人", factionIds: ["nonexistent"] },
    base,
  );
  assert.equal(badRef.ok, false);
  assert.match(badRef.errors.join(""), /势力/);
});

test("validateCreation accepts valid drafts and reuses explicit id when allowed", () => {
  const ok = validateCreation(
    "location",
    { name: "听雨亭", connections: ["gate"] },
    base,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.id, "听雨亭");

  const withId = validateCreation(
    "item",
    { id: "rain-bell", name: "雨铃", summary: "旧码头的信物", locationIds: [] },
    base,
    { allowExistingId: true },
  );
  assert.equal(withId.ok, true);
  assert.equal(withId.id, "rain-bell");
});

test("all five kinds map onto the correct world collection", () => {
  assert.equal(CREATABLE_KINDS.faction.collection, "factions");
  assert.equal(CREATABLE_KINDS.role.collection, "roleTemplates");
  assert.equal(CREATABLE_KINDS.location.collection, "locations");
  assert.equal(CREATABLE_KINDS.item.collection, "items");
  assert.equal(CREATABLE_KINDS.character.collection, "characters");
});

test("createEntity for role uses description field and stamps provenance", () => {
  const next = createEntity(
    "role",
    { name: "客卿", description: "外聘散人，不受门规约束", factionIds: ["guild"], locationIds: ["gate"] },
    base,
  );
  assert.equal(next.roleTemplates.at(-1).provenance.source, "player_created");
  assert.equal(next.roleTemplates.at(-1).description, "外聘散人，不受门规约束");
});

test("buildCreationDraftMessages carries kind, intent and world context", () => {
  const messages = buildCreationDraftMessages({
    kind: "faction",
    intent: "一个隐居在山中的炼丹门派",
    world: base,
    fields: { name: "丹霞谷" },
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /门派\/势力/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.kind, "faction");
  assert.equal(payload.userFields.name, "丹霞谷");
  assert.equal(payload.world.title, "书");
});

test("unknown kind is rejected in all entry points", () => {
  assert.equal(validateCreation("spell", { name: "x" }, base).ok, false);
  assert.throws(() => createEntity("spell", { name: "x" }, base), /未知的实体类型/);
});

test("createEntity back-links new locations so travel options can reach them", () => {
  const next = createEntity("location", { name: "听雨亭", connections: ["gate"] }, base);
  const gate = next.locations.find((item) => item.id === "gate");
  assert.ok(
    (gate.connections ?? []).includes("听雨亭"),
    "既有地点应反向挂链，让新地点进入可见集合",
  );
  // 原世界未被原地修改。
  assert.equal(
    (base.locations.find((item) => item.id === "gate").connections ?? []).includes("听雨亭"),
    false,
  );
  // 之后的创建不重复挂链。
  const next2 = createEntity("location", { name: "山神庙", connections: ["gate"] }, next);
  const gate2 = next2.locations.find((item) => item.id === "gate");
  assert.equal(gate2.connections.filter((id) => id === "听雨亭").length, 1);
});

test("playerCreationsView lists only player-created entities of all five kinds", () => {
  let world = createEntity(
    "faction",
    { name: "听雨阁", summary: "旧码头的散修结社", locationIds: ["gate"] },
    base,
  );
  world = createEntity("location", { name: "听雨亭", connections: ["gate"] }, world);
  world = createEntity("item", { name: "雨铃", summary: "旧码头的信物" }, world);
  world = createEntity(
    "character",
    { name: "守亭人", summary: "看管听雨亭的老人", locationIds: ["听雨亭"] },
    world,
  );
  world = createEntity("role", { name: "客卿", description: "外聘散人" }, world);
  const view = playerCreationsView(world);
  assert.deepEqual(view.factions.map((item) => item.name), ["听雨阁"]);
  assert.deepEqual(view.locations.map((item) => item.name), ["听雨亭"]);
  assert.ok(view.locations[0].connections.includes("gate"));
  assert.deepEqual(view.items.map((item) => item.name), ["雨铃"]);
  assert.deepEqual(view.characters.map((item) => item.name), ["守亭人"]);
  assert.deepEqual(view.characters[0].locationIds, ["听雨亭"]);
  assert.deepEqual(view.roles.map((item) => item.name), ["客卿"]);
  // 原著实体一律不进清单。
  assert.equal(view.characters.some((item) => item.id === "guide"), false);
});

test("seedCreatedCharacter registers the new character as met and locates it", () => {
  const state = {
    locationId: "gate",
    entityStates: { guide: { status: "active", locationId: "tower" } },
    discoveredCharacterIds: ["guide"],
  };
  const next = seedCreatedCharacter(state, {
    id: "守亭人",
    name: "守亭人",
    locationIds: ["听雨亭"],
    factionId: "guild",
  });
  assert.equal(next.entityStates["守亭人"].status, "active");
  assert.equal(next.entityStates["守亭人"].locationId, "听雨亭");
  assert.equal(next.entityStates["守亭人"].factionId, "guild");
  assert.ok(next.discoveredCharacterIds.includes("守亭人"));
  // 原状态未被原地修改。
  assert.equal(state.entityStates["守亭人"], undefined);
  // 草稿没写落点时，人物落在玩家眼前。
  const bare = seedCreatedCharacter(
    { locationId: "gate", entityStates: {}, discoveredCharacterIds: [] },
    { id: "x" },
  );
  assert.equal(bare.entityStates.x.locationId, "gate");
  // 重复播种不重复登记。
  const twice = seedCreatedCharacter(next, { id: "守亭人", locationIds: ["听雨亭"] });
  assert.equal(twice.discoveredCharacterIds.filter((id) => id === "守亭人").length, 1);
});

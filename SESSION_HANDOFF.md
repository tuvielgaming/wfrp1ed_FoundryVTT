# Session Handoff

**Date:** 2026-08-13  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change and preserve user commits made between assistant turns.

Latest implementation commit before this handoff save:

```text
981eaeed86320f17467dd4eba8e46ab00673cc23
Expose tactical parry selection API
```

Latest user-authored combat-sheet visual adjustment explicitly recorded in the previous handoff and still to be preserved:

```text
308b5fdd996a3683e67da68e096f0eb9c79cc347
Adjust melee wepon table top display
```

Earlier user-authored visual adjustments which must also remain preserved:

```text
39a9b2bb288e74f5e451fcde9e08780b67806ec6
Crit wound placement
```

```text
91b3fd95b3d4300b51ef1cd0a45fecff19249892
Small Wound lock marker alignment
```

---

# Immediate continuation checkpoint

The session stopped after runtime-confirming the tactical parry Item-selection layer.

Before implementing the next combat mechanics, the user must re-upload:

```text
WFRP Core RuleBooks.zip
```

The repository ZIP is **not** needed; live GitHub access is available.

Do not implement the next Parry/Dodge mechanics from memory. First audit the exact English WFRP 1e Core rules for defensive timing, Parry, Dodge Blow, limits and modifiers. Then compare the Polish Core for official terminology/differences. English controls mechanics; Polish controls terminology unless a genuine edition difference is found and discussed.

Immediate next implementation direction after that audit:

```text
successful melee attack
→ pending defence opportunity
→ Parry / Dodge / no defence
→ if Parry: choose the actual currently legal held Item
→ defensive test
→ continue/cancel hit as the audited Core rules require
```

Parry/Dodge must remain responses to a pending incoming attack, not disconnected standalone rolls.

---

# Runtime-confirmed foundations

## Wounds / damage

- Remaining Wounds persist and stop at zero.
- Per-hit overflow is `criticalValue`; negative Wounds are never critical-state storage.
- Classic sheet shows remaining/max Wounds and protects manual editing.
- Generic immutable `DamagePacket` + `DamageResolver` flow exists.
- Damage is applied explicitly from ChatMessage state.
- Damage permission: GM OR target Actor OWNER.
- Double application is protected.
- Critical routing distinguishes `unspecified`, `detailed`, and `sudden-death`.

Canonical boundary:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

## Sudden Death / Fate

Runtime-confirmed:

```text
damage applied
→ pending Sudden Death
→ explicit Resolve Critical
→ real 1d100
→ Actor-authoritative critical resolution
→ separate result ChatMessage
```

Fatal result applies the defeated/dead overlay. GM or target OWNER may spend one Fate Point to avert death; Fate decreases by one and defeated status is removed. Spending Fate does not heal Wounds.

The Classic sheet exposes one visible Fate/Punkty Przeznaczenia value. Internal `fate.value/max` remains transitional technical debt and must not be exposed as a WFRP 1e current/max UI.

## Luck / Szczęście

Stable identity:

```text
rulesId: luck
English: Luck
Polish: Szczęście
```

Runtime-confirmed:

- GM global daily reset with Players selected by default and NPC/Monsters optional.
- Secret GM-only `1d6` allowance per selected Actor with Luck.
- Players do not see hidden daily pool rolls.
- d100/K100 ±10 and provider-exposed d6/K6 ±1.
- repeated Luck uses on the same physical roll while daily uses remain.
- append-only `luckHistory`.
- original Foundry Roll remains the physical roll; effective values are audited separately.

## Movement / held items

Audited terms:

```text
Jumping = Zeskok
Falling = Upadek
Leaping = Skok
```

Runtime-confirmed:

- Zeskok and Skok calculations.
- Zeskok generic damage integration.
- movement Luck re-resolution before irreversible downstream consequences.
- per-client localization for implemented result cards.
- held-items check decoupled from Zeskok into its own real 1d100 ChatMessage.
- if Luck reduces Zeskok damage to zero before the dependent check, the held-items button disappears.
- separate held-items result supports repeated useful Luck +10.

Still open:

- standalone `Upadek / Falling`;
- actual `drop-held-items` application.

---

# Critical Wound persistent state — IMPLEMENTED AND RUNTIME-CONFIRMED

Implemented:

```text
module/data-models/item/CriticalWoundData.mjs
module/sheets/CriticalWoundItemSheet.mjs
templates/item/critical-wound-sheet.hbs
css/sheets/critical-wound-item.css
module/sheets/CriticalWoundsWindow.mjs
module/health/HealthCategoryIntegration.mjs
```

The `criticalWound` Item subtype is a native Foundry v14 TypeDataModel with a dedicated ItemSheetV2. The Item sheet and embedded Active Effect lifecycle were runtime-confirmed.

The Classic sheet uses **Psychika i zdrowie** as a compact launcher area. Current implemented category:

```text
Rany krytyczne / Critical Wounds
```

The category window lists, creates, opens and removes Actor-owned `criticalWound` Items, displays the count, and world Critical Wound Items can be dragged onto an Actor.

Future Diseases/Choroby, Mutations/Mutacje, etc. should get their own launcher and purpose-built window only when their real Item/data contract exists.

---

# Detailed Critical Hits — RULEBOOK AUDITED, IMPLEMENTED, END-TO-END RUNTIME TEST DEFERRED

The English and Polish WFRP 1e Core Rulebooks were previously supplied. Detailed Critical Hits / Trafienia krytyczne were visually audited from printed pp. 122–124 in both editions.

Implemented:

```text
module/criticals/CoreDetailedCriticalTables.mjs
module/criticals/DetailedCriticalResolver.mjs
module/criticals/DetailedCriticalIntegration.mjs
module/criticals/CriticalWoundApplication.mjs
templates/chat/detailed-critical-result.hbs
```

The GM-ready hook materializes ten managed Core RollTables:

```text
6 × Critical Hit Chart variants: +1, +2, +3, +4, +5, +6+
1 × Arm effects
1 × Head effects
1 × Body effects
1 × Leg effects
```

Intended lifecycle:

```text
real combat damage with critical.mode = detailed
→ apply damage
→ Resolve Detailed Critical
→ real d100
→ separate detailed result card
→ nonfatal result: Apply Critical Wound
→ exactly one Actor-owned criticalWound Item
→ visible under Psychika i zdrowie / Rany krytyczne
```

Immediate-fatal detailed results use the existing defeated/Fate lifecycle.

End-to-end runtime testing remains deferred until real combat supplies Strength/weapon damage, Toughness and armour mitigation. Do **not** call the detailed-critical end-to-end path runtime-confirmed yet.

Ongoing detailed-critical consequences such as bleeding, temporary incapacity, characteristic penalties, unconsciousness, amputation/recovery, and forced Sudden Death routing are still deliberately not automated until stable consequence/ActiveEffect consumer contracts exist.

---

# Physical inventory and combat equipment foundation

## Canonical physical Item state

Persistent physical Item state remains precise:

```text
state.mode = carried | held | worn
state.hand = none | right | left | both
```

User-facing UI simplifies this to **Carried / Used**, but the internal held/worn distinction must remain because combat, armour and dropping Items need it.

Physical Item work now includes Weapon, Armour and ordinary Equipment inventory state. Dragged physical Items are normalized to carried / no hand rather than inheriting inappropriate active state.

## Unified inventory — IMPLEMENTED

The earlier handoff described page-2 unified **Ekwipunek / Equipment** as the next feature. That is now stale: the master physical inventory implementation was added on 2026-08-12.

Relevant implementation sequence includes:

```text
902fad223c2580f01d20b7087088a99db904882e  Add Classic inventory host
2a704c5f2a10e135cf6ed412a536a538282238b2  Add Classic master inventory integration
a81e3766f90b5f048c2993f6edbe1802bcf4ebf9  Mount master inventory on Classic page two
4b827e9e3a809edf92a59e21063823b40f6d8f15  Load Classic master inventory
2d4e51204d9cfaf2c0fb5849d5e2fa55a7ca92e1  Add full physical inventory manager window
```

The inventory direction remains:

```text
page-2 Ekwipunek = master physical inventory
page-1 weapon/armour tables = combat-oriented summaries
```

Do not re-create a second competing inventory architecture.

## Weapon / Armour facts currently stored

Weapon facts include:

- melee/ranged kind;
- ordinary/specialist/improvised group;
- handedness;
- parry suitability and main-rule parry bonus;
- optional Weapon Modifier values, stored but not automatically enabled;
- ranged short/long/max range;
- effective Strength;
- reload.

Armour facts include:

- Armour class (Shield/Mail/Plate/Leather/Other);
- Armour Points;
- explicit coverage for six humanoid body locations;
- parry suitability and bonus for Shields;
- carried/held/worn state.

Current resolver APIs include:

```text
game.WFRP1ED.equipment.resolver.armourAt(actor, location)
game.WFRP1ED.equipment.resolver.shieldArmour(actor)
game.WFRP1ED.equipment.resolver.parryOptions(actor)
```

`armourAt` includes active Shield AP for actual combat by default. Classic-sheet presentation may call it with `includeShields: false` because the printed sheet records Shield separately.

## Armour equip / Initiative rule direction

Armour equip legality must enforce per-location layering and must not silently auto-unequip equipment to make a choice legal.

Contextual armour Initiative penalties are exposed as independent selectable `-10` rule effects. If multiple ambiguous penalties could stack, do not silently canonicalize the ambiguity; GM adjudication remains required until the relevant Core interaction has been fully audited.

---

# Classic-sheet UI work after the previous handoff

Additional 2026-08-12 work includes:

- dynamic Classic tables made independently scrollable;
- further table-scrolling refinement;
- Foundry-style editable document images restored;
- Classic Actor portrait/image editing added and visually refined;
- adjustable portrait framing/zoom using a fixed clipping frame.

Keep these changes when working on combat. They are not reasons to redesign the Classic sheet.

The previous handoff's separate whole-sheet scroll-preservation issue should not be declared resolved unless specifically runtime-confirmed. If it resurfaces, inspect the live scroller/hook ordering rather than layering speculative fixes.

---

# Combatant Attacks / Ataki economy — IMPLEMENTED AND CORRECTED TO CORE MODEL

Relevant implementation commits:

```text
fb41fa8b9c67fbb1f3621bc2c3efdd6b3765d809  Add Combatant attack economy service
c317779e1e43c00f833551801ffcd4876f01b4da  Add WFRP combat lifecycle hooks
343e169ae7673f069b02cdc55a0b89fbe3cadd21  Register WFRP Combat and attack economy API
7093fe2fccca01acc8e724627bc7548301e3d12f  Correct Core attack and parry economy
```

Canonical design:

- Actor characteristic `A / Attacks` is the permanent allowance.
- Runtime spending belongs to the **Combatant**, so separate tokens of the same Actor can maintain independent encounter state.
- Attacks are a **round resource**.
- Round start resets the resource.
- There is **no `parryDebt`** and no next-round parry debt model.
- An ordinary attack spends one A.
- An ordinary parry spends one A.
- A shield parry spends **all A still remaining when the shield parry is declared**.
- Parries made before the Combatant's own turn reduce the A available for attacks on that turn.
- After the Combatant's own turn, unused A can still pay for later parries in the same round, but the attack window has closed: those points cannot later become attacks.

Current persistent Combatant attack-economy state is based on:

```text
round
spent
parriesThisRound
turnStarted
turnCompleted
```

Do not reintroduce the rejected `parryDebt` design.

Public API:

```text
game.WFRP1ED.combat.attacks
```

---

# Tactical Parry Item selection — IMPLEMENTED AND RUNTIME-CONFIRMED

Core resource-cost modes are defined in:

```text
module/combat/CombatParryRules.mjs
```

Current modes:

```text
oneAttack
allRemainingAttacks
```

`CombatEquipment.parryOptions(actor)` attaches the correct mode to each currently held suitable parry Item:

- ordinary suitable weapon → `oneAttack`;
- held Shield → `allRemainingAttacks`.

New tactical selection service:

```text
module/combat/CombatParrySelection.mjs
```

Public API:

```text
game.WFRP1ED.combat.parrySelection
```

Important design decision: when a defender holds both a suitable one-handed weapon and a Shield, **the system must not silently choose which Item parries**. It is a tactical player decision because the modifiers and A costs differ.

The selection service returns presentation-safe choices including:

```text
itemUuid
itemName
itemType
baseBonus
optionalBonus
totalBonus
attackCostMode
attackCost
remainingAttacksBefore
remainingAttacksAfter
```

It re-resolves the selected Item against current Actor/Combatant state before authoritative commitment so a stale dialog cannot use a dropped/put-away Item or submit an arbitrary cheaper shield cost.

### Runtime confirmation from the final test of this session

With **2 A remaining**, the user runtime-tested a defender holding `Topór` and `Shield`.

Observed choices:

```text
Topór
  type: weapon
  bonus: 0
  costMode: oneAttack
  cost: 1
  before: 2
  after: 1

Shield
  type: armour
  bonus: +20
  costMode: allRemainingAttacks
  cost: 2
  before: 2
  after: 0
```

Overall result also reported:

```text
remainingAttacks: 2
parryAttemptsRemaining: 2
resourceCanParry: true
canParry: true
choices: 2
```

This slice is **runtime-confirmed**.

Do not call `commitSelectedParry()` from a disconnected standalone UI. It is intentionally a resource/selection primitive for the future pending defence transaction.

---

# Next combat implementation path

The old handoff's sequence "inventory → attack economy" is complete enough to move forward. The immediate path is now:

1. Re-upload/audit the English and Polish Core Rulebooks for exact Parry/Dodge defensive rules before further coding.
2. Implement the first real melee attack transaction far enough to create a pending incoming-hit/defence state.
3. Implement the defender response:

```text
Parry / Dodge / none
```

4. For Parry, present the currently legal `CombatParrySelection` choices and commit the selected physical Item through GM-authoritative state.
5. Resolve the audited defensive WS/Dodge test.
6. On an undefended/failed defence, continue:

```text
hit location from reversed attack d100
→ damage roll
→ Strength + weapon
→ Toughness + armour by location
→ existing DamagePacket
→ Apply Damage
→ detailed/Sudden Death critical pipeline
```

7. Only after this stable melee slice expand to charge, ranged attack/reload/range, surprise, fleeing and optional Weapon Modifiers.

The Core Weapon Modifiers table is optional. Storing modifier fields does not mean the optional rule is enabled.

---

# Documentation debt

`RULEBOOK_IMPLEMENTATION.md` still contains older implementation-status statements from before current Wounds/Fate/Luck/detailed-critical/combat-equipment/inventory/attack-economy work. Do not trust its old status rows blindly.

Update that existing document in place when the current combat slice reaches a stable checkpoint; do not create a competing audit/status document.

---

# Other intentionally open work

1. First real melee attack + pending defence transaction.
2. Exact Core audit and implementation of Dodge/Parry response rules.
3. End-to-end runtime test of detailed Critical Wounds through real combat damage.
4. Detailed Critical consequence/ActiveEffect contracts and recovery automation.
5. Standalone `Upadek / Falling`.
6. Real `drop-held-items` application using canonical held state.
7. Fate internal `{value,max}` cleanup to final one-value contract with migration.
8. Revisit any unresolved whole-Classic-sheet scroll reset only if still reproducible.
9. Item-image placeholder/default Foundry image behavior and remaining portrait/skill-panel UI polish if still open in runtime.
10. Future Psychika i zdrowie categories such as Diseases and Mutations only after real Item/data contracts are audited.
11. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

---

# Persistent cautions

- Foundry runtime validation by the user is definitive.
- Fetch current GitHub source before every edit.
- Preserve user commits made between assistant sessions.
- Use native Foundry v14 APIs and Documents.
- Verify Core rules before encoding mechanics; do not preserve an implementation merely because its console tests passed if the rule model is wrong.
- English Core controls mechanics; Polish Core controls official terminology unless a real rules difference is found and discussed.
- Never use negative Wounds for critical state.
- Do not apply damage at roll-calculation time.
- Preserve the original physical roll when post-roll mechanics alter an effective result.
- Avoid irreversible downstream consequences until post-roll interventions are finished.
- Resolve synthetic/token Actors before world prototypes when a ChatMessage identifies a token.
- Do not infer mechanical identity from localized names; use stable IDs/flags.
- Keep damage, critical resolution, Fate and consequence permissions separate.
- Do not create an Apply action unless the underlying persistent model can actually represent and perform the consequence.
- Keep user-facing equipment state simple, but retain mechanically necessary internal precision.
- Do not auto-select weapon vs Shield for Parry when multiple legal held Items exist.
- Do not reintroduce `parryDebt`.

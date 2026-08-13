# Session Handoff

**Date:** 2026-08-13  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub/current `master` is the implementation source of truth. Fetch the exact current file and blob SHA before every write. Preserve unrelated/user-authored changes.

Latest implementation commit before this handoff save:

```text
805bfde7544aca16be3e1a445d60efbbf605d354
Use stateful owner edit icons
```

Important recent user-authored visual commit which must be preserved:

```text
84108b417bcae42666182e45292b3efb051fca3f
Player edit togle style update.
```

Earlier user-authored visual commits still to preserve:

```text
308b5fdd996a3683e67dd4eba8e46ab00673cc23  (old handoff typo risk: always inspect GitHub history before relying on this line)
39a9b2bb288e74f5e451fcde9e08780b67806ec6  Crit wound placement
91b3fd95b3d4300b51ef1cd0a45fecff19249892  Small Wound lock marker alignment
```

---

# Immediate continuation checkpoint

The session ended after runtime-confirming the first real melee-attack UX/foundation and its sheet/chat adjudication refinements.

The next implementation step should be:

```text
successful real melee attack
→ create pending defence response for the actual target
→ defender chooses exactly ONE:
      Parry
      Dodge
      None
→ if Parry: choose actual currently legal held parrying Item
→ resolve audited defensive test/effect
→ continue the same attack transaction into hit location/damage if defence does not negate/reduce it
```

Do **not** continue building defence as a disconnected console-only subsystem. It must now be attached to the real attack transaction/chat lifecycle.

If exact new WFRP 1e mechanics beyond the already-audited Parry/Dodge/ordinary melee slice are needed, re-upload/read the English and Polish Core Rulebooks before encoding them. English mechanics are authoritative; Polish is terminology/localization unless a real edition difference is found.

---

# Rulebook audit conclusions that now control combat design

## Parry / Parowanie

The earlier no-debt interpretation was corrected. `parryDebt` is required.

Core conclusions already audited this session:

- Parry is a WS test.
- A successful Parry reduces the incoming damaging blow by `1d6`; it does not simply turn the hit into a miss.
- An ordinary parry costs the character their **next Attack whether the parry succeeds or fails**.
- A character may attempt at most `A` parries per round.
- The parry-attempt limit and attack-cost timing are separate concepts.
- A character may parry after their own turn/after current attacks are exhausted; the lost Attack then becomes future debt.
- Shield parry gives its Core bonus and loses all following attacks; if no current attack window remains, that cost suppresses the next attack window through debt.
- The system must never interpret available A + possible debt as extra parry attempts. Example `A=2` means at most 2 parry attempts in the round, not 4.

Canonical conceptual separation:

```text
parriesThisRound
    → permission limit
    → maximum = Actor A

parryDebt
    → future Attack cost timing
```

Do not remove `parryDebt` again.

## Dodge Blow / Uniki

Audited Core conclusions:

- Dodge Blow uses an Initiative test.
- A successful Dodge ignores all damage from that blow.
- At most one Dodge Blow attempt per combat round.
- Only against a blow the character sees coming.
- Hand-to-hand only; not against normal missile fire.
- Dodge does not spend A.

For one incoming blow, defence selection is explicitly **mutually exclusive** by project decision:

```text
Parry OR Dodge OR None
```

No `failed Dodge → Parry` and no `failed Parry → Dodge` against the same attack.

---

# Defence foundation — IMPLEMENTED, QUERY LAYER RUNTIME-CONFIRMED

Existing public APIs:

```text
game.WFRP1ED.combat.dodge
game.WFRP1ED.combat.defence
game.WFRP1ED.combat.parrySelection
```

`CombatDefenceOpportunity.melee(combatant, { seenComing })` returns exactly-one response choices and combines current Parry and Dodge availability.

Runtime-confirmed before moving to real attacks:

```text
Parry  available
Dodge  available
None   available
selectionMode = exactlyOne
```

and with `seenComing = false`:

```text
Dodge.available = false
reason = not-seen-coming
Parry unchanged
None available
```

Parry choice runtime-confirmation with `A=2`, no current attack window, `Topór` + `Shield` held:

```text
Topór
  bonus 0
  immediate cost 0
  debtAdded 1
  next attack window 2 → 1

Shield
  bonus +20
  immediate cost 0
  debtAdded 2
  next attack window 2 → 0
```

This is a rules/query foundation only. The next step is to let a real successful attack own the pending defence transaction.

---

# Real melee attack vertical slice — IMPLEMENTED AND RUNTIME-CONFIRMED

The attack mechanism now exists through real Foundry sheet/chat UI.

Key modules include:

```text
module/combat/CombatAttackLauncher.mjs
module/combat/CombatAttackDialog.mjs
module/combat/CombatAttackResolution.mjs
module/combat/PendingCombatAttack.mjs
module/combat/CombatAttackResultChat.mjs
module/combat/CombatAttackBootstrap.mjs
module/targets/ActorTargetResolver.mjs
module/combat/CombatAttackRangeRules.mjs
```

Relevant first-slice commits include:

```text
474681f92f771fa5f4a13042696513d5a8b031c9  Add pending melee attack chat card
832a8867604185ddde28de7e78ad5ca5973d33e8  Style combat attack dialogs and chat context
7d1abe5fed4186ddaa9c61cb697f4558ccf05308  Match melee attack hover to rollable UX
1c6a50ea33915fbdea6aeb8a0141e40621796aa0  Load combat attack transaction modules
c63ac304ae8924df172b4275377d47970b4b0b89  Let attackers resolve target in attack dialog
```

## Weapon sheet UX

Equipped/held melee weapons are rollable with the same visual language as rollable characteristics.

Canonical interaction:

```text
Left click          → initiate attack
Shift + left click  → open/edit Item
```

Avoid adding permanent edit icons to every row. Right-click is intentionally not the universal edit gesture; keep it available for context-specific behavior.

Ranged weapons are intentionally not yet executable through the melee A-spending path.

## Targeting UX

Combat targeting reuses the Standard-Test philosophy rather than inventing an unrelated target model.

The attack dialog supports target selection before rolling, including a modal-friendly visible-token picker so the user does not need to remove dialog focus and press Foundry `T`.

Player/owner attack dialog can:

```text
select visible token
use current Foundry target
clear target
choose No defender / object
```

GM additionally may choose a world Actor.

The pending chat target card follows the same staged behavior:

```text
choose/fill target first
→ verify displayed target
→ press explicit Roll/Rzuć
```

Selecting a target in the pending card must NOT immediately execute the attack.

Players should not see Actor-sidebar drag/chooser controls that they normally cannot use. Sidebar Actor selection/drop remains GM-facing. Canvas tokens should be selected/targeted, not dragged around as a pseudo-drop workflow.

`No defender / object` is a valid target mode for doors/obstacles and other abstract attacks where a defending Actor is intentionally absent.

## Combat Tracker is optional for making an attack

Runtime-confirmed current contract:

- If the Actor is part of a started Combat, Combatant turn/A automation applies.
- If the Actor is **not** a participant in the started Combat (or there is no started Combat), an equipped melee weapon can still roll an attack normally.
- Out-of-combat attacks do not automatically spend the Actor-level manual A value.

This is intentional: Combat Tracker automation enhances play but is not required for basic weapon tests.

## Attack chat result

Attack result uses the existing generic WS Test engine/card, augmented with combat context such as weapon, target and Attacks spent.

Do not create a second d100/WS test implementation for combat.

The generic Test engine owns physical d100, target value, modifiers/effects and GM adjudication; the attack transaction owns attacker, weapon, target mode, Combatant resource spending and future defence/damage state.

---

# Attacks / A current value and Combatant economy — CURRENT CONTRACT

Actor characteristic `A` remains the permanent allowance.

Inside a started Combat, temporary rule state belongs to the Combatant and includes real attack spending, parry attempt count and `parryDebt`.

Outside Combat, the Classic sheet exposes an Actor-level manual current-A value for abstract play/adjudication. It is editable like Wounds when owner editing is allowed, but attack rolls outside Combat do not automatically consume it.

Classic display remains simple:

```text
2/2
1/2
0/2
```

No `↻` prefix.

Manual values are validated/clamped to `0..A`; entering e.g. `32` for `A=2` is set to `2` with a user-facing notification.

## Reset timing

Important corrected project requirement:

```text
Next Turn          → do NOT reset A
Next Turn          → do NOT reset A
Next Combat Round  → normal round reset
```

Starting a Combatant's turn only opens its attack window and pays real accumulated parry debt. Ordinary A refresh is a **round-start** operation.

Adding a Combatant to an already running Combat initializes its combat Attack state cleanly from permanent A. It must not reset Wounds.

Manual same-round adjudication must not be encoded as fake parry debt. Preserve real rules state separately.

---

# Shared owner-edit permission — IMPLEMENTED AND RUNTIME-CONFIRMED

Wounds and A no longer use separate visible permission toggles.

There is one Actor-level switch for manually managed sheet values:

```text
module/sheets/ActorOwnerEditPermission.mjs
```

GM always retains manual adjudication. A non-GM must be an explicit OWNER and the shared switch must be enabled.

The central switch synchronizes legacy Wounds/Attack permission flags for compatibility with existing guards.

User-authored positioning/CSS from commit `84108b417...` must be preserved.

Current icon state, requested and runtime-approved:

```text
editing OFF → red user-lock icon
editing ON  → green user-check icon
```

Latest icon commit:

```text
805bfde7544aca16be3e1a445d60efbbf605d354
Use stateful owner edit icons
```

This shared mechanism should be reused for future manually managed sheet fields rather than adding more local lock buttons.

---

# TestResult post-roll editing — IMPLEMENTED AND RUNTIME-CONFIRMED

## General modifier

Blank, `+`, or `-` in the chat `Modyfikator testu / Test modifier` input normalizes to `0` instead of throwing an error.

Relevant commit:

```text
eb434ea365a8796a8c2ed033f2638c30944b92d5
Normalize incomplete GM modifier edits
```

## Manual/physical d100 result

Completed Test cards expose the Roll/Rzut value as editable for:

```text
GM
OR
OWNER of the Actor represented by the ChatMessage speaker
```

Permission follows the Actor, not whichever user clicked the roll button.

For synthetic/token Actors, resolve the speaker Token Actor before falling back to the world Actor.

An Actor OWNER can edit even a result originally generated by the GM. Non-GM edits are committed through the active GM socket so ChatMessage author ownership does not block the correction.

Changing Roll/Rzut recalculates the existing Test snapshot/result without rerolling. The original Foundry Roll remains preserved as the physical/original roll for audit/Luck semantics.

Relevant commit:

```text
5572949afdafc0790ffb5eef18d28856103ec267
Update test roll edit permissions
```

---

# Classic portrait placeholder — IMPLEMENTED AND RUNTIME-CONFIRMED

A character with no custom portrait now shows a discoverable placeholder in the Classic portrait slot. Foundry's default mystery-man image is treated as no custom portrait. A real portrait covers the placeholder while preserving the existing editable/framing behavior.

Relevant commits:

```text
55696caeadb8eb0c2a17b9f392dc2c78ce25f1d0  Show Classic portrait placeholder
1a95f12afe54931f9131e0927d8627d391f557fb  Keep portrait placeholder behind real image
809926959307cdbeda78e5bfc991c55c97b4c74d  Treat Foundry default portrait as placeholder
```

---

# Ranged attack architecture decisions — DESIGNED, NOT YET END-TO-END IMPLEMENTED

Do not force ranged/firearm/spell attacks through the melee resolver.

Current high-level direction:

```text
Combat Action
    weapon melee
    weapon ranged
    spell
```

Mounted/flying/cover/etc. are combat context/modifiers, not separate attack families.

For ordinary ranged attacks:

- use BS, not WS;
- normal missile attacks do not enter the ordinary Parry/Dodge melee-defence stage;
- range can affect BS and damage;
- firearms have additional traits/rules such as reload/misfire but should not be invented as a completely separate range table without Core audit;
- thrown weapons may use Actor Strength semantics rather than fixed ES depending on authored weapon data.

## Automatic Range Effects project decision

Range automation belongs to the **attack transaction**, not the Weapon Item.

Desired ranged attack option:

```text
[✓] Automatically apply range effects
    Distance: [0]
```

When enabled, derive range band and apply rule-derived BS + damage effects. When disabled, do no automatic range mechanics; GM/player can use ordinary test modifier and a separate damage modifier.

The GM must be able to change Automatic Range Effects/distance on the chat card **after the roll**, recalculating the existing test using the same physical d100 rather than forcing a repeat test.

Manual mode should expose a chat Damage modifier input.

`CombatAttackRangeRules.mjs` and attack-result range editing foundation exist, but ranged attack execution is intentionally disabled until its own correct lifecycle is implemented. Do not call ranged end-to-end behavior runtime-confirmed yet.

---

# Magic / mounted / flying future architecture cautions

Magic must not be implemented as merely another Weapon kind. Spells may use completely different casting, automatic-hit, target and mitigation procedures.

Mounted/flying combat should modify context rather than create combinatorial attack types. Future attack context may need facts such as:

```text
attackerMounted
targetMounted
attackerMoving
attackerFlying
targetFlying
horizontal/vertical distance
cover
firing into melee
size
```

Before encoding any of these special rules, audit the exact English Core pages and Polish terminology.

---

# Existing runtime-confirmed foundations to preserve

## Wounds / damage

- Remaining Wounds persist and stop at zero.
- Per-hit overflow is `criticalValue`; negative Wounds are never critical-state storage.
- Classic sheet remaining/max Wounds and manual edit guard work.
- Generic immutable `DamagePacket` + `DamageResolver`.
- Damage explicitly applied from ChatMessage state.
- Permission GM or target Actor OWNER.
- Double application protected.
- Critical modes: `unspecified`, `detailed`, `sudden-death`.

Canonical:

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
→ real d100
→ Actor-authoritative critical resolution
→ separate result ChatMessage
```

Fatal result applies defeated/dead overlay. GM or target OWNER may spend one Fate Point; Fate decreases and defeated status is removed. Fate spend does not heal.

## Luck / Szczęście

Stable rules ID `luck`; English `Luck`, Polish `Szczęście`.

Runtime-confirmed hidden daily d6 allowance, d100 ±10 / exposed d6 ±1, repeated useful use, append-only history, and preservation of original physical Roll.

## Movement

Audited terminology:

```text
Jumping = Zeskok
Falling = Upadek
Leaping = Skok
```

Runtime-confirmed Zeskok/Skok, Zeskok damage integration, Luck re-resolution and held-items check.

Open: standalone Upadek and actual drop-held-items application.

## Critical Wound Item / Detailed Criticals

Persistent `criticalWound` Item and Classic Critical Wounds launcher/window are runtime-confirmed.

Detailed Critical Core tables/resolver are implemented, but full real-combat end-to-end detailed-critical test remains deferred until the actual combat damage path reaches it.

## Physical inventory/equipment

Canonical internal state remains:

```text
state.mode = carried | held | worn
state.hand = none | right | left | both
```

Do not collapse internal held/worn state even though user-facing UI simplifies it.

Unified page-two Ekwipunek is the master physical inventory; page-one weapon/armour tables are combat summaries. Do not create a second inventory architecture.

Current resolver APIs include:

```text
game.WFRP1ED.equipment.resolver.armourAt(actor, location)
game.WFRP1ED.equipment.resolver.shieldArmour(actor)
game.WFRP1ED.equipment.resolver.parryOptions(actor)
```

---

# Immediate next implementation path

1. Inspect CURRENT GitHub before writing, especially:

```text
module/combat/CombatAttackLauncher.mjs
module/combat/CombatAttackResolution.mjs
module/combat/CombatAttackResultChat.mjs
module/combat/PendingCombatAttack.mjs
module/combat/CombatAttackEconomy.mjs
module/combat/CombatParrySelection.mjs
module/combat/CombatDefenceOpportunity.mjs
module/combat/CombatDodgeEconomy.mjs
module/combat/CombatEquipment.mjs
module/tests/TestManager.mjs
module/tests/TestContext.mjs
module/tests/TestResult.mjs
module/tests/TestResultChat.mjs
module/tests/TestResultModifierToggle.mjs
module/documents/Wfrp1edCombat.mjs
```

2. Attach defence only to a **successful real melee attack with a defending Actor**.
3. Persist one pending defence decision tied to that attack/chat state.
4. Defender gets exactly one choice: Parry / Dodge / None.
5. If Parry, use current tactical `CombatParrySelection`; never auto-pick weapon vs Shield.
6. Spend Parry/Dodge resources only on confirmed declaration, not merely opening UI.
7. Resolve audited defence against the same attack transaction.
8. Then continue surviving hit into:

```text
hit location from reversed attack d100
→ weapon/Strength damage
→ Toughness + armour by location
→ existing DamagePacket
→ Apply Damage
→ detailed/Sudden Death critical pipeline
```

9. After stable melee end-to-end path, implement ranged attack lifecycle and runtime-test GM-editable Automatic Range Effects.
10. Later special contexts: charge, reload/misfire, surprise, fleeing, mounted/flying combat, optional Weapon Modifiers, spells.

---

# Persistent project cautions

- User Foundry runtime validation is definitive; do not claim runtime confirmation without it.
- Fetch exact current GitHub files before every edit and preserve user commits.
- Foundry v14 native APIs/Documents; JavaScript only.
- Verify Core rules before encoding mechanics. English mechanics / Polish terminology.
- Do not build duplicate Test/target/inventory architectures.
- Do not apply irreversible damage at attack-roll time.
- Preserve original physical rolls for post-roll adjudication/Luck.
- Resolve synthetic/token Actor before world prototype when ChatMessage identifies a token.
- Stable IDs/flags, not localized names, for mechanical identity.
- Never auto-select weapon vs Shield for Parry.
- Never remove the currently required `parryDebt` model based on the old stale handoff wording.
- `RULEBOOK_IMPLEMENTATION.md` contains stale status material; update the existing document at a stable combat checkpoint rather than creating a competing audit/status file.

---

# Open work

1. Real successful melee attack → pending Parry/Dodge/None transaction.
2. Defence result integration with the attack/damage continuation.
3. Hit location + real melee damage through existing DamagePacket.
4. End-to-end detailed critical test through real combat damage.
5. Ranged attack lifecycle, range automation and chat adjudication.
6. Firearm reload/misfire and thrown-weapon semantics after exact Core audit.
7. Mounted/flying/special combat context.
8. Spell/magic combat architecture and implementation.
9. Detailed Critical consequence/ActiveEffect contracts/recovery.
10. Standalone Upadek/Falling and actual drop-held-items.
11. Fate internal `{value,max}` cleanup/migration.
12. Whole Classic sheet scroll reset only if still reproducible.
13. Remaining Actor/Item types/classic sheet sections for MVP.

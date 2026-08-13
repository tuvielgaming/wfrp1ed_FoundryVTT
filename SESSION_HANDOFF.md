# Session Handoff

**Date:** 2026-08-13  
**Purpose:** Single current implementation/architecture checkpoint. Do not create competing progress documents.

## Source of truth

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub/current `master` is authoritative. Fetch the exact current file + blob SHA before every write and preserve user commits.

Latest implementation commit before this save:

```text
805bfde7544aca16be3e1a445d60efbbf605d354
Use stateful owner edit icons
```

Recent user-authored visual commit to preserve:

```text
84108b417bcae42666182e45292b3efb051fca3f
Player edit togle style update.
```

Earlier user-authored visual commits to preserve:

```text
308b5fdd996a3683e67da68e096f0eb9c79cc347  Adjust melee wepon table top display
39a9b2bb288e74f5e451fcde9e08780b67806ec6  Crit wound placement
91b3fd95b3d4300b51ef1cd0a45fecff19249892  Small Wound lock marker alignment
```

---

# Immediate continuation

The session ended after runtime-confirming the first real melee-attack UX/foundation and its sheet/chat adjudication refinements.

Next implementation step:

```text
successful real melee attack
→ pending defence bound to that attack/target
→ defender chooses exactly ONE:
      Parry
      Dodge
      None
→ if Parry: choose actual currently legal held parrying Item
→ resolve audited defence
→ continue same attack into hit location/damage if appropriate
```

Do not continue building defence as a disconnected console subsystem.

If new WFRP 1e mechanics beyond already-audited Parry/Dodge/ordinary melee are needed, re-read/re-upload the English + Polish Core books before coding. English controls mechanics; Polish controls terminology/localization unless a real edition difference exists.

---

# Core combat conclusions already audited

## Parry / Parowanie

`parryDebt` is required. Do not remove it again.

- Parry is a WS test.
- Successful Parry reduces the damaging blow by `1d6`; it does not simply turn the hit into a miss.
- Ordinary Parry loses the character's **next Attack**, success or failure.
- Maximum Parry attempts per round = Actor `A`.
- Parry-attempt limit and Attack-cost timing are separate.
- Parry after own turn / after current attacks are gone is legal; lost Attack becomes future debt.
- Shield Parry uses its Core bonus and loses all following attacks; if no current attack window exists, the cost suppresses the next one through debt.

Canonical separation:

```text
parriesThisRound → permission limit, max A
parryDebt        → future Attack-cost timing
```

`A=2` means at most **2** parries in the round, never `2 current + 2 debt = 4`.

## Dodge Blow / Uniki

- Initiative test.
- Success ignores all damage from that blow.
- One attempt per combat round.
- Only against a blow seen coming.
- Hand-to-hand only; not normal missile fire.
- Does not spend A.

Project decision for one incoming blow:

```text
Parry OR Dodge OR None
```

No failed-Dodge-then-Parry or failed-Parry-then-Dodge path.

---

# Defence query foundation — implemented + runtime-confirmed

Public APIs:

```text
game.WFRP1ED.combat.dodge
game.WFRP1ED.combat.defence
game.WFRP1ED.combat.parrySelection
```

`CombatDefenceOpportunity.melee(combatant, { seenComing })` returns mutually exclusive response availability.

Runtime-confirmed:

```text
seenComing=true:
  Parry true
  Dodge true
  None true
  selectionMode exactlyOne

seenComing=false:
  Dodge false / not-seen-coming
  Parry unchanged
  None true
```

Parry choice with `A=2`, no current attack window, Topór + Shield held:

```text
Topór  bonus 0   immediate 0   debt +1   next window 2→1
Shield bonus +20 immediate 0   debt +2   next window 2→0
```

Never auto-pick weapon vs Shield.

---

# Real melee attack slice — implemented + runtime-confirmed

Key modules:

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

Interaction convention:

```text
Left click          → primary action / attack
Shift + left click  → open/edit Item
```

Equipped melee weapon rows use the same rollable visual language as characteristics.

## Target UX

Attack popup allows the user to select/verify/change target before Roll, including a modal-friendly visible-token selector so Foundry `T` focus quirks are not required.

Owner/player controls:

```text
visible token selector
Use current target
Clear target
No defender / object
```

GM additionally can choose a world Actor.

Pending chat target card uses the same staged contract:

```text
choose/fill target
→ verify displayed target
→ explicit Roll/Rzuć
```

Selecting a target must not immediately roll.

Player pending cards should not render Actor-sidebar drag/chooser controls they normally cannot use. Canvas token interaction is selection/targeting, not dragging the token.

## Combat Tracker is optional

Runtime-confirmed design:

- Actor participating in started Combat → active-turn/A automation applies.
- Actor not participating / no started Combat → equipped melee weapon may still roll an attack.
- Out-of-combat attack does **not** automatically consume manual Actor A.

Combat Tracker enhances automation; it is not required for basic weapon tests.

Attack result reuses the existing generic WS Test card/engine. Do not create a second d100/WS system.

---

# Attacks / A current contract

Permanent Actor `A` = allowance.

Inside Combat: Combatant owns runtime spending, parry count and `parryDebt`.

Outside Combat: Classic sheet exposes Actor-level manual current A for abstract play/adjudication. It is editable under the same owner-edit permission as Wounds; out-of-combat attacks do not spend it automatically.

Display remains simple:

```text
2/2
1/2
0/2
```

No `↻` prefix.

Manual values are clamped to `0..A` with a user notification.

## Reset timing — important

```text
Next Turn          → DO NOT reset A
Next Turn          → DO NOT reset A
Next Combat Round  → normal reset
```

Starting a turn opens the attack window and pays real parry debt. Ordinary refresh is round-start only.

Adding a Combatant to a running Combat initializes Attack state from permanent A; it must not reset Wounds.

Do not encode a manual same-round correction as fake parry debt.

---

# Shared owner-edit permission — implemented + runtime-confirmed

Central Actor-level permission:

```text
module/sheets/ActorOwnerEditPermission.mjs
```

GM always retains adjudication. Non-GM must be explicit Actor OWNER and the shared switch must be enabled.

The switch controls current Wounds, current A, and is the reusable pattern for future managed sheet values. Legacy Wounds/Attack permission flags are synchronized for compatibility.

Preserve the user's current positioning/CSS from commit `84108b417...`.

Current approved icon states:

```text
editing OFF → red user-lock
editing ON  → green user-check
```

Latest icon commit: `805bfde7544aca16be3e1a445d60efbbf605d354`.

---

# TestResult post-roll adjudication — implemented + runtime-confirmed

## General modifier

Blank, `+`, or `-` in `Test modifier / Modyfikator testu` normalizes to `0` instead of throwing.

Commit:

```text
eb434ea365a8796a8c2ed033f2638c30944b92d5
Normalize incomplete GM modifier edits
```

## Manual/physical d100 Roll

Completed Test cards allow Roll/Rzut editing for:

```text
GM
OR
OWNER of the Actor represented by the ChatMessage speaker
```

Permission follows the Actor, not whichever user clicked Roll.

For token/synthetic Actors resolve speaker Token Actor before world prototype.

An OWNER can edit even a GM-created result; non-GM changes are committed through the active GM socket. Existing TestResult snapshot is recalculated without rerolling. The original Foundry Roll remains preserved for audit/Luck semantics.

Commit:

```text
5572949afdafc0790ffb5eef18d28856103ec267
Update test roll edit permissions
```

---

# Classic portrait placeholder — implemented + runtime-confirmed

A character without a custom portrait now shows a discoverable placeholder. Foundry default mystery-man counts as no custom portrait. A real portrait covers the placeholder while retaining existing image editing/framing.

Relevant commits:

```text
55696caeadb8eb0c2a17b9f392dc2c78ce25f1d0  Show Classic portrait placeholder
1a95f12afe54931f9131e0927d8627d391f557fb  Keep portrait placeholder behind real image
809926959307cdbeda78e5bfc991c55c97b4c74d  Treat Foundry default portrait as placeholder
```

---

# Ranged attack direction — designed, not end-to-end implemented

Do not force ranged/firearm/spell attacks through melee resolution.

For ordinary ranged attacks:

- use BS;
- normal missile fire does not use ordinary Parry/Dodge;
- range may modify BS and damage;
- firearm reload/misfire and thrown-weapon ES semantics require exact Core handling;
- mounted/flying/cover/etc. are context, not separate attack families.

## Automatic Range Effects decision

Per-attack option, not Weapon property:

```text
[✓] Automatically apply range effects
    Distance: [0]
```

Enabled → derive range band + rule BS/damage effects.  
Disabled → no automatic range mechanics; use ordinary test modifier and separate damage modifier.

GM must be able to edit Automatic Range Effects/distance in chat **after the roll** and recalculate using the same physical d100. Manual mode should expose Damage modifier.

`CombatAttackRangeRules.mjs` and attack-result range-editing foundation exist, but ranged attack execution is intentionally disabled. Do not call ranged end-to-end behavior runtime-confirmed.

Magic is not merely another Weapon kind. Special mounted/flying/magic rules require exact Core audit before implementation.

---

# Existing foundations to preserve

## Wounds / damage

- Remaining Wounds stop at zero.
- Overflow = `criticalValue`; never store negative Wounds as critical state.
- Generic immutable `DamagePacket` + `DamageResolver`.
- Explicit Apply Damage from ChatMessage state.
- GM or target Actor OWNER permission.
- Double application protection.
- Critical modes `unspecified`, `detailed`, `sudden-death`.

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

## Sudden Death / Fate

Runtime-confirmed fatal-result → defeated state → GM/OWNER Fate spend. Fate spend removes defeated and decrements Fate; it does not heal.

## Luck / Szczęście

Stable `rulesId=luck`; hidden daily d6 allowance, d100 ±10 / exposed d6 ±1, repeated useful use, append-only history, original physical Roll preserved.

## Movement

```text
Jumping = Zeskok
Falling = Upadek
Leaping = Skok
```

Zeskok/Skok, Zeskok damage, Luck re-resolution and held-items check runtime-confirmed. Open: standalone Upadek + actual drop-held-items.

## Critical Wounds / Detailed Criticals

Persistent `criticalWound` Item + Classic launcher/window runtime-confirmed. Detailed Core tables/resolver implemented; full real-combat detailed-critical end-to-end test remains deferred until actual combat damage reaches it.

## Inventory/equipment

Canonical internal state:

```text
state.mode = carried | held | worn
state.hand = none | right | left | both
```

Page-2 Ekwipunek = master physical inventory. Page-1 weapon/armour tables = combat summaries. Do not create a second inventory architecture.

Resolver APIs:

```text
game.WFRP1ED.equipment.resolver.armourAt(actor, location)
game.WFRP1ED.equipment.resolver.shieldArmour(actor)
game.WFRP1ED.equipment.resolver.parryOptions(actor)
```

---

# Next implementation path

Inspect CURRENT GitHub first, especially:

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

Then:

1. Attach pending defence only to a successful real melee attack with a defending Actor.
2. Persist one defence decision tied to that attack/chat state.
3. Defender chooses exactly Parry / Dodge / None.
4. Parry uses current tactical Item selection; never auto-pick weapon vs Shield.
5. Spend defence resources only on confirmed declaration, not opening UI.
6. Resolve defence against the same transaction.
7. Continue surviving hit:

```text
reverse attack d100 → hit location
→ Strength/weapon damage
→ Toughness + armour by location
→ existing DamagePacket
→ Apply Damage
→ detailed/Sudden Death critical pipeline
```

8. After stable melee end-to-end, implement ranged lifecycle and runtime-test GM-editable Automatic Range Effects.
9. Later: charge, reload/misfire, surprise, fleeing, mounted/flying, optional Weapon Modifiers, spells.

---

# Persistent cautions / open work

- User Foundry runtime validation is definitive.
- Fetch exact GitHub source before every edit.
- Foundry v14 native APIs/Documents; JavaScript only.
- Verify Core mechanics before coding; English mechanics / Polish terminology.
- Preserve original physical rolls before post-roll edits/Luck.
- Resolve token/synthetic Actor before world prototype where appropriate.
- Stable IDs/flags, not localized names, for mechanical identity.
- Never auto-select weapon vs Shield for Parry.
- Keep `parryDebt`.
- `RULEBOOK_IMPLEMENTATION.md` is stale; update that existing file at a stable combat checkpoint rather than creating another status doc.

Open work:

1. Real successful melee attack → pending Parry/Dodge/None transaction.
2. Defence → hit location → melee damage → DamagePacket.
3. Real-combat detailed critical end-to-end test.
4. Ranged lifecycle/range automation.
5. Firearm/thrown special rules after exact Core audit.
6. Mounted/flying/special combat context.
7. Spell/magic combat.
8. Detailed Critical consequence/ActiveEffect contracts/recovery.
9. Standalone Upadek and actual drop-held-items.
10. Fate internal `{value,max}` cleanup/migration.
11. Whole Classic sheet scroll reset only if still reproducible.
12. Remaining Actor/Item/classic-sheet MVP sections.

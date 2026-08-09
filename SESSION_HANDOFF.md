# Session Handoff

**Date:** 2026-08-09  
**Purpose:** Current handoff for the next working step. Replace/update this file rather than creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact files before every change.

### Validation checkpoint

Last fully live-tested Standard Test checkpoint:

- `2953dd2c174ec4e2a17f39702d1fa2fa491b0dca` — Foundry v14 ChatMessage context-menu hook correction.

The user confirmed that the Standard Test launcher, single-window configuration, result card, GM-editable general modifier, and GM-controlled result-detail visibility are working correctly through that checkpoint.

### Movement work added after the last live-tested checkpoint

The following movement-procedure commits exist on `master` but have not yet completed live Foundry validation:

- `49276ebce2c28a5dbf537a9552742be4b4e4033c` — movement Standard Test procedure definitions.
- `7db637a68514703c48e5ef35af738a82d8f48b7d` — Jump/Leap movement procedure implementation.
- `c887bd051ddd583367be01d174c4527ee5e81b9b` — movement procedure result template.
- `aa4257d8ebe01fd0658604786c36195efd70f025` — expose `Skok` / `Zeskok` through the Standard Test launcher.

## Rulebook verification for movement

The English and Polish WFRP 1e Core Rulebooks were supplied separately on 2026-08-09 and checked before implementing movement procedures.

Verified sources:

- English Core Rulebook, printed p. 75 — `JUMPING, FALLING, LEAPING, CLIMBING`.
- Polish Core Rulebook, printed p. 75 — `ZESKOK, UPADEK, SKOK, WSPINACZKA`.
- English Skills section — Acrobatics and Clown descriptions.
- Polish Skills section — Akrobatyka and Błaznowanie terminology/effects.

Verified movement rules relevant to the current implementation:

- `Zeskok` / Jumping is a controlled vertical descent and is not a d100 Standard Test.
- Damage is based on rounded-up height minus a d6 result; positive remainder is Wounds.
- Armour and Toughness do not reduce that damage.
- Acrobatics improves the damage-reduction die by +2.
- Clown/Błaznowanie improves the Jump/Fall damage-reduction die by +1.
- If Wounds are suffered, there is a 50% chance of dropping held items.
- `Skok` / Leaping is horizontal distance and is not a d100 Standard Test.
- With at least 2 yards/metres run-up: `2 × Movement - 1d6`.
- Without sufficient run-up: `2 × Movement - 2d6`.
- Minimum achieved distance is 1 yard/metre.
- Acrobatics adds +2 yards/metres to Leap distance.
- If the achieved distance is insufficient, the character falls.
- These movement procedures consume a full round.

## Approved damage-application architecture

The user explicitly approved a WFRP4e-like chat workflow for damage application.

### Core rule

A roll/procedure calculates and publishes damage, but does not silently mutate Wounds at calculation time.

The damage-producing result stores a structured **damage packet**. Applying that packet is a separate explicit action.

### Permission rule

`Apply Damage / Zastosuj obrażenia` should be available from the ChatMessage context menu to:

- a GM; or
- a user who owns the Actor receiving the damage.

Permission is checked against the **damage target**, not necessarily the Actor who made the roll.

### Damage packet direction

A damage packet should contain enough data for one generic damage service to resolve many sources, for example:

- raw damage amount;
- target Actor UUID;
- source kind/id (weapon, movement, spell, environmental effect, etc.);
- whether Armour applies or is ignored;
- whether Toughness applies or is ignored;
- optional hit location;
- other source-specific mitigation/rule flags when actually required by audited rules;
- application state/transaction metadata.

`Zeskok` is intended to be the first consumer and should produce a packet with Armour and Toughness explicitly ignored.

### Central ownership

Do not implement Zeskok-specific Wounds subtraction.

Target architecture:

`damage-producing procedure/action`
→ `DamagePacket`
→ `DamageResolver`
→ `DamageApplication`
→ Actor Wounds / later critical-damage handling.

The damage resolver, not the chat template and not the source procedure, owns mitigation rules.

### Application transaction

After damage is applied, the ChatMessage should record at least:

- amount actually applied;
- Wounds before and after;
- user who applied it;
- applied timestamp/state.

The action must be protected against accidental double application.

A later GM-only `Undo Applied Damage` action is desirable, but it must use a recorded transaction rather than blindly adding Wounds back. It is a later step, not required for the first Apply Damage implementation.

### Critical damage caution

The repository does not yet have a complete audited shared damage → zero/negative Wounds → critical handling contract for Character/NPC/Creature Actors. Do not bypass that dependency by directly subtracting Wounds inside movement code.

## Approved Skill architecture: Foundry Active Effects

The user reconfirmed the previously discussed direction: **Skill mechanics should be authored through Foundry Active Effects on Skill Items**, rather than hardcoded by Skill name or duplicated across test executors.

Foundry v14 Item Documents natively support embedded ActiveEffects and an ActiveEffect may contain multiple changes. The system may also register WFRP-specific custom effect change types/renderers/handlers when the built-in Add/Multiply/Override semantics are insufficient.

### Skill identity

Keep the stable language-neutral `system.rulesId` for core identity/migration/content mapping, but mechanical consumers must not depend on localized `Item.name`.

`rulesId` identifies what core Skill an Item represents. Active Effects describe what that Skill actually does.

### Multiple effects per Skill

A Skill Item may contain multiple independent Active Effects.

Example approved direction for `Clown / Błaznowanie`:

- one effect affecting Jump/Fall procedure mechanics;
- another effect affecting other applicable tests/procedures such as Bluff/Busk according to the audited rules.

Do not collapse unrelated mechanical effects into one hardcoded Skill switch.

### Current movement implementation is transitional

`MovementStandardTest.mjs` currently contains a local `MOVEMENT_SKILL_BONUSES` table for Acrobatics and Clown. This duplicates mechanics that should belong to Skill Active Effects.

This table is **not approved as the final architecture** and should be refactored out before more Skill-dependent mechanics are built on it.

The existing `standard-test-skill-rules.mjs` and `StandardTestSkillResolver.mjs` are useful audited/transitional sources, but their long-term mechanical data should migrate into Active Effect definitions on Skill Items/core compendium content rather than remain a second permanent rules database.

## Required WFRP Active Effect vocabulary

A single effect type of `Standard Test + numeric modifier` is not sufficient for WFRP 1e Skills.

The Skill audit shows that core Skills use several different mechanical patterns. The Active Effect editor/resolver must be able to represent at least the following categories.

### 1. Test target modifier

Adds/subtracts from the acting character's chance for a named test or test family.

Examples include ordinary `+10`, `+15`, `+20`, etc. modifiers to Bluff, Gossip, Construct, Disease, Poison, Risk, Estimate, and similar tests.

Required fields conceptually:

- target scope: Standard Test / characteristic test / named procedure / combat test family;
- target id;
- operation/modifier;
- numeric value or formula;
- optional condition.

### 2. Opponent/target modifier

Some Skills alter the opponent's characteristic/chance rather than the acting character's target.

The effect model therefore needs an explicit target side, e.g. `self`, `opponent`, `test-target`, rather than assuming every modifier changes the owner.

### 3. Derived/formula modifier

Some bonuses are calculated from characteristics or other runtime values rather than a fixed number.

The effect value must support a safe formula/expression contract, not only a numeric constant.

### 4. Choice/conditional modifier

Some Skills have different effects depending on the fictional situation.

Example pattern: one value while stationary, another while moving; environment-dependent Rural/Urban variants; mounted/specific-weapon/etc. conditions.

The system should expose candidate effects and let the GM decide applicability where the rule requires judgement. Do not silently infer every narrative condition.

### 5. Repeated-acquisition scaling

Some Skills gain additional bonuses when acquired multiple times, such as Pick Lock/Pick Pocket.

The effect contract therefore needs access to acquisition count or a stacking policy, rather than baking repeated-acquisition math into individual test executors.

### 6. Procedure parameter modifier

Some Skills modify a non-d100 procedure parameter rather than a percentile target.

Examples:

- Acrobatics: Jump/Fall die result +2;
- Acrobatics: Leap distance +2;
- Clown: Jump/Fall die result +1;
- Acute Hearing: hearing distance;
- Swim: movement allowance while swimming;
- Luck: post-roll die/result adjustment uses;
- other movement, healing, crafting or special-procedure values.

The effect must identify a stable procedure parameter such as `movement.jump.reductionDie`, `movement.leap.distance`, etc. The procedure consumes generic parameter effects; it must not know Skill identities.

### 7. Characteristic/profile modification

Some Skills/talents directly modify Actor characteristics or derived profile values, e.g. Movement, Strength, Toughness or initiative-related values.

These can often use normal Foundry Add/Override Active Effect changes against canonical Actor data/derived effect inputs, but the project must preserve one source of truth and avoid persisting formatted derived values.

### 8. Combat-rule modifier

Some Skills modify combat-specific calculations rather than Standard Tests, including hit modifiers, weapon handling, damage, stun/critical location behaviour, dodge/disarm/wrestling procedures, etc.

These should target stable combat effect keys/parameters and be consumed by the combat subsystem. Do not force combat semantics into the Standard Test resolver.

### 9. Capability / rule permission

Many Skills do not provide a numeric bonus at all. They permit an action, remove a normal penalty, allow automatic success in certain circumstances, enable spellcasting/specialist weapons/languages, or unlock a dedicated procedure.

The Active Effect vocabulary therefore needs boolean/capability effects such as `grant`, `ignorePenalty`, `allowProcedure`, or an equivalent stable contract.

### 10. Outcome/rule transformation

Some Skills change what success/failure means, modify recovery time, alter damage caused, adjust error margins, allow post-roll modification, change ranges/distances, or add secondary effects.

These require procedure/combat/result hooks rather than simple addition to an Actor field.

## Recommended Active Effect authoring UI

For Skill Items, do not expose users only to raw arbitrary data paths.

Preferred WFRP-facing workflow:

1. Add Active Effect to the Skill Item.
2. Add one or more WFRP effect changes.
3. Choose an **Effect Category** (Test Modifier, Procedure Parameter, Characteristic, Combat, Capability, Result Transformation, etc.).
4. Choose a stable target from filtered dropdowns (for example a registered Standard Test, characteristic, movement procedure, combat parameter).
5. Choose self/opponent/target side when relevant.
6. Enter a numeric value or approved formula when that effect type supports it.
7. Configure stacking/acquisition behaviour when relevant.
8. Add an optional human-readable condition/GM applicability note where automatic evaluation is inappropriate.

Use stable IDs internally and localized labels in the UI.

The UI should allow multiple Active Effects and multiple changes where the Skill has several independent mechanical consequences.

## Foundry v14 Active Effect implementation notes

Verified against Foundry v14 documentation:

- Item Documents have an embedded `effects` collection.
- Active Effects may contain multiple `changes`.
- Core change semantics include additive/multiplicative/override-style changes.
- Foundry v14 allows systems/modules to register additional Active Effect change types with handlers and custom renderers.
- Active Effect application supports phases; use custom phases only when a WFRP subsystem needs to consume effects at a specific lifecycle point.

Do not depend on old v10/v11 transfer-workaround assumptions without checking v14 behaviour when implementation begins.

## Approved per-roll Active Effect applicability overrides

The user approved temporary enable/disable controls for contextual Skill effects in the roll/test configuration window.

### Persistent state versus per-roll state

Do **not** toggle the underlying Foundry ActiveEffect Document merely because a player or GM enables/disables an effect for one roll. That would change the Skill's persistent state and could affect later tests unexpectedly.

Instead, test/procedure configuration must build a **per-roll effect-selection snapshot** in the test/procedure context. The snapshot records which candidate Active Effect changes are applied or suppressed for that one execution only.

The resulting chat breakdown should preserve the selected effects/sources so the roll remains auditable after Actor/Item data changes.

### Effect applicability modes

The WFRP effect contract should distinguish at least:

- `automatic` — mechanically unconditional for the relevant target; applied by default and normally shown as checked/locked in the roll UI;
- `contextual` — potentially applicable but dependent on circumstances or GM judgement; displayed as an interactive checkbox/toggle in the roll UI;
- `manual` — special rule/capability requiring explicit choice or additional input before use.

The exact field names can be finalized during implementation, but this semantic distinction is approved.

### Roll-window presentation

When the selected test/procedure has candidate contextual effects, show an **Applicable effects / Efekty** section in the same roll window rather than opening another dialog.

Conceptual example:

```text
Efekty
☑ Akrobatyka — +2 do wyniku K6
☐ Błaznowanie — +1 do wyniku K6
☑ Modyfikator sytuacyjny ...
```

Changing a checkbox must immediately affect the preview/final calculation for that roll, but must not mutate the Skill Item or ActiveEffect Document.

The section should normally show only effects relevant to the currently selected test/procedure, not every Active Effect owned by the Actor.

### Player and GM control

- A player may select/suppress contextual candidate effects available from an Actor they are allowed to roll/control.
- A GM may select/suppress candidate effects when rolling for any Actor.
- Automatic effects should not normally be suppressible by a player merely to gain an advantage unless the rule itself makes them optional.
- GM must retain authority to override applicability where WFRP requires adjudication.

A player-initiated local dialog and a GM client are not automatically the same live form. First implementation should therefore treat the **user initiating/configuring the roll** as the pre-roll selector, while preserving enough effect data in the chat result for GM adjudication. A later shared/pending-GM approval workflow may be added if playtesting shows it is needed.

### Post-roll adjustment direction

The existing GM-editable general modifier demonstrates the desired adjudication pattern. For effect-driven tests, the result snapshot should make individual applied effects visible in the detailed GM breakdown.

A future enhancement may allow GM to toggle eligible contextual effects directly from the chat result and re-evaluate the target/outcome against the **same original dice roll**, similar to editing the general modifier. This should be designed from the same immutable roll snapshot rather than rereading current Actor data.

Do not implement post-roll effect toggling until the Active Effect resolver and result snapshot contracts are stable.

## Immediate next dependency order

1. Design and implement the WFRP Active Effect change contract/editor for Skills, including applicability modes and per-roll selection snapshots.
2. Add relevant-effect selection controls to Standard Test / procedure configuration dialogs.
3. Convert the current movement Skill bonuses to Active Effect-driven procedure parameters and delete the duplicated `MOVEMENT_SKILL_BONUSES` table.
4. Live-test `Skok` / `Zeskok` with automatic/contextual effects enabled and suppressed per roll.
5. Design the generic `DamagePacket` / `DamageResolver` / `DamageApplication` contract.
6. Make Zeskok produce an applicable damage packet and add GM/target-owner `Apply Damage` to the ChatMessage context menu.
7. Live-test damage application and double-application protection.
8. Continue broader Skill-effect migration/integration across Standard Tests, non-standard procedures and combat in dependency order.

## Important cautions

- Mechanics must still be verified against the English Core Rulebook first and Polish Core Rulebook for terminology before encoding each core Skill effect.
- Active Effects are the mechanical representation; localized names are presentation only.
- Do not create a second permanent hardcoded Skill rules registry alongside Active Effects.
- Do not auto-enable situational Skill effects when the rule leaves applicability to GM judgement.
- Do not mutate persistent ActiveEffect enabled/disabled state for one-roll applicability choices.
- Per-roll effect selections belong to TestContext/procedure context and result snapshots.
- Do not force non-d100 procedures or combat mechanics into the generic percentile Test class merely to reuse UI.
- Do not apply calculated damage directly from a roll/procedure; use the approved damage packet/application transaction.
- Foundry runtime validation remains required after each dependency-ordered change.

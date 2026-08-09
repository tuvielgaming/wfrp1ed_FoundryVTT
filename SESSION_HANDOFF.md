# Session Handoff

**Date:** 2026-08-09  
**Purpose:** Current implementation/architecture checkpoint. Replace/update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact files before every code change.

## Live-tested checkpoint

The last fully live-tested Standard Test checkpoint remains:

- `2953dd2c174ec4e2a17f39702d1fa2fa491b0dca` — Foundry v14 ChatMessage context-menu hook correction.

The user confirmed the following as working through that checkpoint:

- Classic-sheet `🎲 TEST STANDARDOWY` row and styling;
- one-window Standard Test configuration;
- conditional Standard Test inputs;
- deferred target selection through chat instead of hard errors;
- compact result cards;
- localized formula display;
- pure-chance `%` display;
- always-present general test modifier;
- GM post-roll modifier editing against the original d100;
- GM-only vs public-full result-detail visibility;
- post-roll visibility switching from the Foundry v14 ChatMessage context menu.

## Movement work on master, not yet fully live-tested

These commits were added after the last fully validated checkpoint:

- `49276ebce2c28a5dbf537a9552742be4b4e4033c` — movement Standard Test procedure definitions;
- `7db637a68514703c48e5ef35af738a82d8f48b7d` — Jump/Leap movement procedure implementation;
- `c887bd051ddd583367be01d174c4527ee5e81b9b` — movement result template;
- `aa4257d8ebe01fd0658604786c36195efd70f025` — expose `Skok` / `Zeskok` through Standard Test launcher.

### Verified rulebook contract

English and Polish WFRP 1e Core Rulebooks were supplied separately and checked before implementation.

Verified sources:

- English Core Rulebook, printed p. 75 — `JUMPING, FALLING, LEAPING, CLIMBING`;
- Polish Core Rulebook, printed p. 75 — `ZESKOK, UPADEK, SKOK, WSPINACZKA`;
- English Skills section — Acrobatics and Clown;
- Polish Skills section — Akrobatyka and Błaznowanie.

Relevant verified mechanics:

- `Zeskok` / Jumping is a non-d100 controlled vertical descent procedure;
- rounded height minus d6 gives Wounds when positive;
- Armour and Toughness do not reduce those Wounds;
- Acrobatics adds +2 to the Jump/Fall reduction die;
- Clown/Błaznowanie adds +1 to the Jump/Fall reduction die;
- suffering Wounds triggers the rulebook 50% held-item drop check;
- `Skok` / Leaping is a non-d100 horizontal-distance procedure;
- run-up of at least 2 yards/metres: `2 × Movement - 1d6`;
- insufficient/no run-up: `2 × Movement - 2d6`;
- minimum achieved distance is 1 yard/metre;
- Acrobatics adds +2 yards/metres to Leap distance;
- insufficient distance means the character falls;
- these procedures consume a full round.

## Approved damage architecture

The user approved a WFRP4e-like chat workflow for applying calculated damage.

### Core contract

A roll/procedure may calculate damage, but must **not silently mutate Wounds at calculation time**.

The result publishes/stores a structured `DamagePacket`. Applying the packet is a separate explicit transaction.

Target architecture:

`damage-producing action/procedure`
→ `DamagePacket`
→ `DamageResolver`
→ `DamageApplication`
→ Actor Wounds / later critical handling.

### Permission rule

`Apply Damage / Zastosuj obrażenia` from the ChatMessage context menu should be available to:

- a GM; or
- a user who owns the Actor receiving the damage.

Permission is checked against the **damage target**, not necessarily the rolling Actor.

### Damage packet

The generic packet must support at least:

- raw damage amount;
- target Actor UUID;
- source kind/id;
- Armour applies/ignored;
- Toughness applies/ignored;
- optional hit location;
- future audited mitigation/special-rule flags;
- application state/transaction metadata.

`Zeskok` should be the first consumer and should explicitly mark Armour and Toughness as ignored.

### Transaction requirements

After applying damage, the ChatMessage should record at least:

- amount actually applied;
- Wounds before and after;
- user who applied it;
- timestamp/state.

Prevent accidental double application.

A later GM-only `Undo Applied Damage` is desirable, but must use the stored transaction rather than simply adding Wounds back.

Do not implement Zeskok-specific Wounds subtraction. The repository still needs a shared audited damage/critical pipeline for Character/NPC/Creature Actors.

## Approved Active Effect architecture

### System-wide rule

**WFRP Active Effects are a system-wide rule mechanism, not a Skill-only mechanism.**

Skills are the first Item type that will receive the WFRP-specific effect editor/resolver integration, but the effect vocabulary and resolver must be reusable by other rule-bearing Items.

Current registered Item types are:

- `career`;
- `skill`;
- `weapon`;
- `equipment`;
- `trait`;
- `spell`.

Only `skill` currently has a dedicated native WFRP TypeDataModel/sheet. Dedicated `armour`, `disease`, and other future Item types are **not registered yet** and must be introduced deliberately rather than guessed into existing temporary data contracts.

When dedicated types such as Armour/Disease are implemented, they must use the same Active Effect infrastructure.

### Intended sources of Active Effects

The common resolver must eventually be able to consume relevant effects originating from, for example:

- Skills;
- weapons;
- armour;
- general equipment;
- spells;
- diseases;
- traits/talents/special rules;
- careers when a career legitimately grants a mechanical state/effect;
- future conditions/status Items;
- optional-rule/module Items.

A subsystem must not care whether an effect came from a Skill, weapon, spell, disease, etc. It asks for effects targeting the rule parameter it owns.

Example:

`combat.damage.amount`

could receive contributions from a weapon, a Skill, a spell, a temporary condition, or another Item without combat code containing identity-specific switches for those Items.

### Item state matters

The common effect contract must support activation policy/source state. Examples:

- Skill effect: normally available because the Actor owns the Skill;
- weapon effect: may require that weapon to be equipped/used for this action;
- armour effect: may require the armour piece to be worn and may be location-specific;
- equipment effect: may require equipped/carried/consumed state depending on its rule;
- spell effect: may be temporary and have duration/expiry;
- disease effect: may depend on disease stage/severity;
- condition/trait effect: may be always-on, temporary, suppressed, or conditional.

Do not permanently apply every embedded Item ActiveEffect merely because the Item exists in the Actor inventory. The WFRP resolver must consider the effect's activation/applicability contract.

### Skill identity and migration

Keep stable language-neutral `system.rulesId` for core Skill identity/migration/content mapping. Mechanical consumers must not depend on localized `Item.name`.

However, mechanics should ultimately come from Active Effect changes rather than a second permanent hardcoded Skill-rules database.

### Current movement table is transitional

`MovementStandardTest.mjs` currently contains a local `MOVEMENT_SKILL_BONUSES` table for Acrobatics and Clown. It duplicates rules that belong in Skill Active Effects.

This table is **not approved final architecture** and must be removed before more Skill-dependent mechanics are built on it.

The procedure should instead request generic parameter effects such as:

- `movement.jump.reductionDie`;
- `movement.fall.reductionDie`;
- `movement.leap.distance`.

It must not ask whether the Actor owns Acrobatics/Clown/Błaznowanie by identity.

## Required WFRP effect vocabulary

One generic `Standard Test + numeric modifier` effect is insufficient.

The common Item Active Effect vocabulary must support at least:

1. **Test target modifier** — named Standard Test, characteristic test, test family, etc.
2. **Target/opponent modifier** — explicit `self` / `target` / `opponent` side.
3. **Derived/formula modifier** — safe formulas, not only fixed integers.
4. **Conditional/contextual modifier** — GM/player applicability decision when fiction matters.
5. **Repeated-acquisition/stacking policy** — needed by repeated Skill acquisitions and other stackable sources.
6. **Procedure parameter modifier** — movement, hearing distance, healing, crafting, etc.
7. **Characteristic/profile modification** — canonical Actor/derived values.
8. **Combat-rule modifier** — hit, damage, weapon handling, critical/stun/location parameters, etc.
9. **Capability/permission** — grant procedure, ignore penalty, allow specialist use, language/spellcasting capability, etc.
10. **Outcome/rule transformation** — changes to success/failure consequences, margin/error, post-roll adjustment, damage/recovery/range transformations, secondary effects.

These categories are not Skill-specific. A weapon, spell, disease, armour piece, trait, or other Item may author changes using the same vocabulary.

## Active Effect authoring UI direction

Do not expose users only to arbitrary raw data paths.

Preferred WFRP-facing authoring flow:

1. Add an Active Effect to an Item.
2. Add one or more WFRP effect changes.
3. Choose `Effect Category`.
4. Choose a stable target from filtered localized dropdowns.
5. Choose side (`self`, `target`, `opponent`) where relevant.
6. Enter numeric value or approved formula when supported.
7. Configure stacking/acquisition behaviour when relevant.
8. Configure applicability/activation mode.
9. Add optional human-readable condition/GM note where automatic evaluation is inappropriate.

Use stable IDs internally and localized labels in UI.

The same editor component should be reusable across WFRP Item sheets. Individual Item sheets may filter categories/targets to those sensible for that Item type, but must not create separate incompatible effect languages.

## Approved per-roll applicability overrides

Temporary effect selection for one roll is required.

### Persistent state vs one-roll state

Do **not** enable/disable the underlying Foundry ActiveEffect Document because a player or GM checks an effect for one roll.

Instead the roll/procedure configuration builds a **per-roll effect-selection snapshot** recording which candidate changes are applied/suppressed for that execution.

The result snapshot should preserve selected effects and source Items so the roll remains auditable even after Actor/Item data changes.

### Applicability modes

The effect contract should distinguish at least:

- `automatic` — unquestionably applies for the relevant target; normally checked/locked;
- `contextual` — candidate effect controlled by checkbox/toggle for the roll;
- `manual` — requires explicit choice/additional input before use.

### Roll window

Show only effects relevant to the currently selected test/procedure, not every effect owned by the Actor.

Conceptual example:

```text
Efekty
☑ Akrobatyka — +2 do wyniku K6
☐ Błaznowanie — +1 do wyniku K6
```

Changing a per-roll checkbox must affect that roll's calculation without mutating the source Item or ActiveEffect.

### Authority

- Player may select/suppress contextual effects available from an Actor they are allowed to roll/control.
- GM may select/suppress candidate effects when rolling for any Actor.
- Automatic effects should not normally be suppressible by players unless the rule makes them optional.
- GM retains adjudication authority for situational applicability.

A later enhancement may permit GM post-roll toggling of eligible contextual effects from the result card, recalculating against the same original dice roll. Do not implement that until the common resolver/result snapshot contracts are stable.

## Immediate dependency order

1. Design the **system-wide WFRP Active Effect contract/resolver**, not a Skill-only resolver.
2. Build the reusable WFRP Active Effect editor component; integrate it into Skill Items first.
3. Add per-roll relevant-effect selection to Standard Test/procedure dialogs.
4. Convert Acrobatics/Clown movement mechanics to Item Active Effects and delete `MOVEMENT_SKILL_BONUSES`.
5. Live-test `Skok` / `Zeskok` with relevant effects enabled/suppressed.
6. Expand the same editor/resolver to other implemented Item types as their data models/sheets are audited (weapon/equipment/spell/trait, then future armour/disease/etc.).
7. Design `DamagePacket` / `DamageResolver` / `DamageApplication`.
8. Make Zeskok produce an applicable damage packet and add GM/target-owner `Apply Damage` in chat.
9. Live-test double-application protection and damage transactions.
10. Continue broader effect integration across combat, magic, equipment, diseases, conditions and other procedures in dependency order.

## Important cautions

- Verify each encoded WFRP mechanic against English Core first and Polish Core for terminology.
- Active Effects are the mechanical representation; localized Item names are presentation only.
- Do not build a second permanent hardcoded Skill/equipment/spell rules registry alongside Active Effects.
- Do not mutate persistent ActiveEffect state for one-roll applicability choices.
- Do not treat every owned/equipped Item effect as universally applicable; activation/source state is part of the contract.
- Keep non-d100 procedures outside the generic percentile Test class.
- Do not apply calculated damage directly from a roll/procedure; use the approved damage transaction pipeline.
- Foundry runtime validation remains required after each dependency-ordered change.

# Session Handoff

**Date:** 2026-08-09  
**Purpose:** Current implementation/architecture checkpoint. Update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact file before every code change.

## Current confirmed checkpoint

The Skill + Active Effect foundation is now live-tested and working in Foundry v14.

### Confirmed persistence

User explicitly confirmed all of the following:

- WFRP rules authored on a world Skill persist after a full Foundry restart;
- dragging that world Skill onto a Character preserves the Active Effect rule setup;
- the Actor-embedded Skill rules also persist after a full Foundry restart;
- Standard Test dialogs discover the copied/persisted effects correctly.

Durable WFRP rule descriptors are mirrored into:

```text
ActiveEffect.flags.wfrp1ed.ruleChanges
```

The existing `system.changes` representation remains as a compatibility/runtime mirror. Skill authoring and the rule resolver prefer the persisted flag copy after reload/drop.

Key commits:

- `8a86af4893b5a0da54669ebb73f2c741de39fe8a` — resolve WFRP rules from persisted Active Effect flags;
- `d1cbfc7b702fff2fd25fc0fc427a0cc42e8edf0e` — persist Skill WFRP rules in Active Effect flags.

### Duplicate Skill prevention — CONFIRMED

The Actor no longer accepts the same Skill identity more than once through normal creation/drop flow.

Identity rule:

- mapped/core Skill: same `system.rulesId` + same `system.specialisation` = duplicate;
- custom/unmapped Skill: same normalized Item name + same `system.specialisation` = duplicate;
- different specialisations remain legal.

The first per-Item `_preCreate` attempt was insufficient during drag/drop because Actor ownership context was not reliable at that lifecycle point.

Final implementation uses batch-wise `Wfrp1edItem._preCreateOperation`, where pending embedded Items already have their Actor parent and the pending document array can be filtered before database creation.

Update-side protection remains so an embedded Skill cannot later be edited into another Skill's identity.

Existing historical duplicates are not auto-deleted; manual cleanup is required because copies may contain different authored effects.

Key commits:

- `370967af7dc819dadd1cd566e43c87e5e4ef5ee6` — initial duplicate guard;
- `df261fe53307860aebc0e2b3be1d3e2343585d03` — enforce uniqueness at Item creation operation; user confirmed this works.

## Startup regression history — IMPORTANT

A persistence experiment temporarily broke clean Foundry startup and caused both Character and Skill documents to open with Foundry `BaseSheet` fallback.

Runtime diagnostic showed:

```text
game.WFRP1ED: undefined
Actor character sheets: {}
Skill sheets: {}
```

A temporary bootstrap probe exposed the exact syntax failure:

```text
RuleEffectResolver.mjs
Private field '#collectEffect' must be declared in an enclosing class
```

Cause: one missing closing brace in the nested Item/effect loop left private class methods parsed outside the class.

Fix:

- `e527d61b4702f32a093d8ef9c6fe3a2cb88140d1` — restore correct `RuleEffectResolver` class structure.

The temporary bootstrap probe was subsequently removed.

**Rule:** startup/import-critical files must be read back after replacement. A hot refresh is not sufficient proof that a clean Foundry boot works.

A small ActiveEffect `wfrp` compatibility declaration may still exist because some world documents were created during the earlier subtype experiment. Do not remove compatibility support casually while existing worlds may still contain those documents. Do not reintroduce the old automatic type-migration hook.

## Active Effect architecture — APPROVED

Active Effects are a system-wide WFRP rule mechanism, not Skill-only.

Skills are the first authoring surface. The common effect infrastructure must later be usable by weapons, armour, equipment, spells, diseases, traits/talents, conditions, and other rule-bearing Items.

Subsystems consume stable rule parameters instead of checking Skill/Item names.

Current examples:

- `test.standard.hide.target`
- `test.characteristic.int.target`
- `procedure.movement.jump.reductionDie`
- `procedure.movement.leap.distance`

Future combat/damage/healing/magic parameters should extend the same vocabulary.

Persistent ActiveEffect enabled/disabled state is separate from per-roll choices.

## Per-roll Active Effect selection — CONFIRMED

Relevant effects are shown directly in the Standard Test dialog.

Approved compact presentation:

```text
☐ Cichy Chód w mieście: +10 (sytuacyjny)
```

Checkbox visuals are confirmed:

- unchecked = simple empty square;
- checked = plain check mark;
- no native Foundry black rectangle/stylized artwork.

Behavior:

- contextual/manual effects can be selected per roll;
- automatic effects are selected by default;
- persistent ActiveEffect state is not mutated by a roll checkbox;
- GM may adjudicate effect selection;
- only effects relevant to the current test/procedure are shown.

## Post-roll Active Effect adjudication — CONFIRMED

GM can enable/disable snapshotted Active Effect modifiers in the expanded test-result chat card after the roll.

The original d100 remains fixed. Toggling recalculates only:

- total modifier;
- final target;
- margin;
- success/failure.

It does not reroll, reread current Actor/Item/ActiveEffect data, or mutate the persistent ActiveEffect.

Unchecked candidates are snapshotted with `enabled: false`, so the GM can enable them after the roll.

The general `Modyfikator testu` remains separately numeric-editable.

## Deferred-target selection — CONFIRMED

Target-dependent Standard Tests such as `Ukrywanie się` preserve checked/unchecked Active Effect selections when the test first creates a pending target request and the GM resolves the target later.

Fix commit:

- `64c847e0039629df688306f827fdd53677aceda4`.

Pending request snapshot version 2 stores a mutable copy of `options.ruleEffects` and nested source metadata, avoiding the previous frozen ChatMessage flag problem.

## Movement procedures / Skills

`Skok` and `Zeskok` mechanics used so far were verified against both English and Polish WFRP 1e Core Rulebooks before implementation.

Movement procedures do not hardcode Skill names. They consume generic Active Effect parameters:

- `procedure.movement.jump.reductionDie`;
- `procedure.movement.leap.distance`.

Do not reintroduce Acrobatics/Clown identity tables into movement executors.

## Damage architecture — APPROVED, NOW CURRENT TASK

User approved a WFRP4e-like workflow where calculated damage appears in chat and is applied only after an explicit user action.

Target architecture:

```text
damage-producing action/procedure
→ DamagePacket
→ DamageResolver
→ DamageApplication
→ Actor Wounds / later critical handling
```

A damage-producing action must **not silently mutate Wounds when damage is calculated**.

`Apply Damage / Zastosuj obrażenia` from a ChatMessage should be available to:

- GM; or
- a user who owns the Actor receiving that damage.

Permission is checked against the damage target, not necessarily the rolling Actor.

Generic `DamagePacket` must support at least:

- raw amount;
- target Actor UUID;
- source kind/id;
- Armour apply/ignore policy;
- Toughness apply/ignore policy;
- optional hit location;
- future special mitigation flags;
- transaction/application state stored with the ChatMessage.

After application, the ChatMessage should record at least:

- amount applied;
- Wounds before;
- Wounds after;
- applying user;
- timestamp;
- applied state;
- enough identity/state to prevent accidental double application.

Possible later GM-only Undo must validate and use the stored transaction; never blindly add Wounds back.

`Zeskok` is intended as the first consumer and is expected to ignore Armour and Toughness, but its exact damage-producing formula must continue to follow the verified English/Polish rulebook source.

### Current rulebook boundary for damage

Repository rulebook audit already verifies:

- remaining Wounds are persistent play state;
- damage reduces remaining Wounds;
- negative remaining Wounds are allowed because excess damage participates in critical damage.

The current Character schema stores this at:

```text
system.status.wounds.value
```

and derives maximum Wounds from the `w` characteristic.

However, generic combat Armour/Toughness mitigation has not yet been fully audited in `RULEBOOK_IMPLEMENTATION.md`. Do not invent that calculation from memory. It is safe to build mechanics-neutral packet/application/transaction contracts first and defer actual mitigation calculation until the relevant English + Polish combat sections are verified.

## Current next order

1. Build immutable/serializable `DamagePacket` contract.
2. Build resolved-damage/application transaction contract around `system.status.wounds.value`.
3. Add target-ownership permission checks using Foundry v14 Document permissions.
4. Add ChatMessage damage flags and `Apply Damage / Zastosuj obrażenia` context action.
5. Prevent double application and record the completed transaction on the message.
6. Audit English + Polish combat damage/Armour/Toughness rules before enabling generic mitigation calculations.
7. Wire verified `Zeskok` damage into the generic pipeline as the first consumer.
8. Later extend the same pipeline to normal weapon/combat damage.

## Foundry v14 API notes verified during current work

- `foundry.utils.fromUuid(uuid)` resolves a Document from its UUID.
- `Document.testUserPermission(user, permission)` is the correct capability test; `CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER` is ownership level 3.
- `Document.update({ "system.status.wounds.value": n })` is the native persistent update path for nested Actor data.
- ChatMessage and Actor Documents support package flags for serializable system metadata.

## Important cautions

- Foundry runtime validation is definitive.
- Do not claim a damage rule is mechanically complete until relevant English mechanics and Polish terminology are verified.
- Do not calculate or mutate persistent ActiveEffect state for per-roll choices.
- Keep non-d100 movement procedures outside generic percentile `Test`.
- Do not apply damage at roll calculation time; use the explicit DamageApplication transaction pipeline.
- Do not auto-delete historical duplicate Skills.
- Avoid touching the now-confirmed Active Effect persistence path unless a concrete defect requires it.

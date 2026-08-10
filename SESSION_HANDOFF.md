# Session Handoff

**Date:** 2026-08-10  
**Purpose:** Current implementation/architecture checkpoint. Update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact file before every code change.

---

# Current confirmed checkpoint

The following slices are live-tested and confirmed in Foundry v14:

1. Skill + Active Effect persistence/adjudication.
2. Duplicate Skill prevention.
3. Generic damage packet + explicit ChatMessage application.
4. Full damage permission matrix: GM, target OWNER, non-owner denial.
5. Double-application protection.
6. Classic-sheet remaining/max Wounds display.
7. Bilingual WFRP 1e movement audit for Zeskok / Upadek / Skok.
8. Zeskok integrated into the generic damage workflow and runtime-confirmed.

The latest movement integration commits are:

```text
1d09753488685d142e0f634a6000fc60f9077b2a
Attach Zeskok damage to generic application workflow

41bebd2524f2e261265dd6461c5594fc7d12b3b6
Document bilingual movement procedure audit
```

The user confirmed that Zeskok damage appears on the existing movement result card, does not apply automatically, exposes `Zastosuj obrażenia`, updates the Actor correctly when applied, and cannot be applied twice.

---

# IMPORTANT RULE CORRECTION — Wounds must never become negative

On 2026-08-10 the user noticed that the current damage implementation allowed Żywotność/Wounds to fall below zero and questioned whether the excess should instead determine critical-hit severity.

The English and Polish WFRP 1e Core Rulebooks were checked directly.

## Verified sources

English Core Rulebook:

- **Combat — Critical Hits / Critical Hit Chart**, printed page 122.

Polish Core Rulebook:

- **Walka — Trafienia krytyczne / Tabela trafień krytycznych**, printed page 122.

## Canonical rule

The user's interpretation is correct:

- remaining Wounds/Żywotność stop at **0**;
- Wounds never become negative;
- when a hit inflicts more resolved damage than the target has remaining Wounds, the excess becomes the **critical value** for that hit;
- example from the English rules: 5 damage against 2 remaining Wounds produces Wounds `2 → 0` and a `+3` critical hit;
- once Wounds are already zero, subsequent damage is used to determine further critical results rather than accumulating as negative Wounds.

Canonical application calculation:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

`criticalValue` is per-hit transaction/result state. It must **not** be encoded by persisting negative remaining Wounds.

Repository audit correction commit:

```text
7281a079b642bc5a76098dfa02adf20b01e35272
Correct Wounds floor and critical-hit overflow rules
```

## Current runtime discrepancy

`module/damage/DamageApplication.mjs` still implements the earlier incorrect behavior and can persist negative `system.status.wounds.value`.

Do not extend damage to `Upadek` or normal combat until this is corrected.

The next runtime change must:

1. clamp remaining Wounds at zero;
2. calculate `criticalValue` from overflow;
3. store `criticalValue` in the immutable/applied damage transaction;
4. expose the critical value in chat/application state when positive;
5. preserve double-application protection and the full permission matrix;
6. define migration/normalization behavior for any test Actors currently holding negative Wounds.

Actual Critical Hit Chart resolution should be a dedicated next subsystem. Do not overload the Wounds field or `DamageApplication` with the whole critical-table lifecycle.

---

# Skill + Active Effect subsystem — CONFIRMED

## Persistence

Confirmed:

- WFRP rules authored on a world Skill survive a full Foundry restart;
- dragging the world Skill onto a Character preserves Active Effect rule setup;
- Actor-embedded Skill rules survive restart;
- Standard Test dialogs discover copied/persisted effects.

Durable WFRP rule descriptors are mirrored into:

```text
ActiveEffect.flags.wfrp1ed.ruleChanges
```

`system.changes` remains as a compatibility/runtime mirror.

Key commits:

```text
8a86af4893b5a0da54669ebb73f2c741de39fe8a
Resolve WFRP rules from persisted Active Effect flags

d1cbfc7b702fff2fd25fc0fc427a0cc42e8edf0e
Persist Skill WFRP rules in Active Effect flags
```

## Duplicate Skill prevention

Confirmed creation identity rule:

- mapped/core Skill: same `system.rulesId` + same `system.specialisation` = duplicate;
- custom/unmapped Skill: same normalized Item name + same specialisation = duplicate;
- different specialisations remain legal.

Final creation guard uses `Wfrp1edItem._preCreateOperation`.

Key commit:

```text
df261fe53307860aebc0e2b3be1d3e2343585d03
Enforce Skill uniqueness at Item creation operation
```

Historical duplicates are not auto-deleted because they may contain different authored effects.

## Per-roll and post-roll adjudication

Confirmed:

- contextual/manual effects can be selected per roll;
- automatic effects are selected by default;
- roll selection does not mutate persistent ActiveEffect state;
- unchecked candidates are snapshotted for GM post-roll adjudication;
- GM toggling recalculates target/modifier/margin only and never rerolls;
- target-dependent pending tests preserve effect selections.

Pending-target preservation commit:

```text
64c847e0039629df688306f827fdd53677aceda4
```

---

# Startup regression caution — IMPORTANT

A prior persistence experiment caused Character and Skill documents to fall back to Foundry `BaseSheet` because of a syntax error in `RuleEffectResolver.mjs`.

Exact historical error:

```text
Private field '#collectEffect' must be declared in an enclosing class
```

Fix commit:

```text
e527d61b4702f32a093d8ef9c6fe3a2cb88140d1
Fix RuleEffectResolver class structure
```

Rule:

- read back startup/import-critical files after replacement;
- if `system.json` changes, perform a full Foundry restart;
- a hot refresh is not proof of clean startup.

A small ActiveEffect `wfrp` compatibility declaration still exists because old world documents may have been created during the earlier subtype experiment. Do not remove it casually and do not restore the old automatic migration hook.

---

# Active Effect architecture — APPROVED

Active Effects are system-wide WFRP rule descriptors, not Skill-only.

Skills are merely the first authoring surface. The common rule language is intended for weapons, armour, equipment, spells, diseases, traits/talents, conditions and other rule-bearing Items.

Subsystems consume stable rule targets rather than Item names.

Current examples include:

```text
procedure.movement.jump.reductionDie
procedure.movement.leap.distance
```

Persistent ActiveEffect enabled/disabled state remains separate from per-roll applicability.

---

# Generic damage subsystem — CONFIRMED EXCEPT CRITICAL OVERFLOW BUG

## Architecture

```text
damage-producing procedure/action
→ DamagePacket
→ DamageResolver
→ DamageResolution
→ explicit ChatMessage Zastosuj obrażenia
→ DamageApplication
→ Actor remaining Wounds
```

Damage calculation and application are deliberately separate. Calculating damage never silently mutates an Actor.

Current files:

```text
module/damage/DamagePacket.mjs
module/damage/DamageResolution.mjs
module/damage/DamageResolver.mjs
module/damage/DamageApplication.mjs
module/damage/DamageChat.mjs
module/damage/DamageBootstrap.mjs
```

`DamageResolver` currently resolves only packets where Armour and Toughness are explicitly ignored. Generic combat mitigation remains disabled until normal combat rules are separately audited.

Runtime API:

```js
game.WFRP1ED.damage
```

## Permission matrix — FULLY CONFIRMED

- GM can apply damage.
- Target Actor OWNER can apply damage.
- Target OWNER can apply damage from a GM-authored ChatMessage even without permission to edit that ChatMessage.
- Non-owner player does not receive the action.
- Double application of the same packet is prevented.

Actor-side application transaction is authoritative because target ownership may differ from ChatMessage ownership.

## Foundry v14 context-menu compatibility — CONFIRMED

Foundry v14 uses:

```text
label
visible
onClick(event, target)
```

The compatibility adapter correctly wraps legacy callback semantics as:

```js
entry.onClick = (_event, target) => legacyCallback(target);
```

Confirmed fix commit:

```text
c0adce4569e39f463b1c9169ed78e8fc94ec66d4
Fix Foundry v14 context menu callback adapter
```

## Remaining Wounds display

Classic profile `Żyw` displays remaining/max, for example:

```text
6/6
5/6
0/6
```

It must never display a negative remaining-Wounds value after the upcoming critical-overflow fix.

The persistent in-play field is:

```text
system.status.wounds.value
```

`flags.wfrp1ed.woundsInitialized` distinguishes the pre-damage synchronization lifecycle from an Actor that has actually entered play-state Wounds tracking.

---

# Movement audit and implementation — CONFIRMED

The uploaded English and Polish WFRP 1e Core Rulebooks were directly checked.

Canonical terminology:

| English | Polish | Meaning |
|---|---|---|
| Jumping | Zeskok | controlled vertical descent |
| Falling | Upadek | uncontrolled vertical descent |
| Leaping | Skok | horizontal jump |

## Zeskok

Verified formula:

```text
zeskokDamage = max(0, ceil(height) - (1d6 + reductionDieBonuses))
```

- Acrobatics contributes +2 through the stable Active Effect target rather than Skill-name hardcoding.
- Positive damage ignores Armour and Toughness.
- If damage is suffered, roll the 50% held-item drop check.
- Full-round procedure.
- Generic damage is attached to the same movement ChatMessage only when positive damage is produced.
- Damage is applied only through explicit `Zastosuj obrażenia`.

Zeskok generic damage integration is runtime-confirmed by the user.

## Upadek

Verified formula:

```text
fallDamage = max(0, 2 * ceil(height) - (1d6 + reductionDieBonuses))
```

Standalone Upadek is **not implemented yet**.

Do not implement it until the Wounds floor / critical-overflow application bug is corrected and tested.

## Skok

With run-up:

```text
distance = max(1, 2 * Movement - 1d6 + leapBonuses)
```

Without sufficient run-up:

```text
distance = max(1, 2 * Movement - 2d6 + leapBonuses)
```

If a Skok fails, the GM determines actual vertical fall height from the scene. Do not infer fall height from horizontal gap distance.

---

# CURRENT NEXT TASK — start here

Do **not** redo the already-confirmed Zeskok or permission tests unless a regression appears.

Next steps in order:

1. Inspect current `DamageApplication.mjs`, `DamageResolution.mjs`, `DamageChat.mjs`, and damage-result rendering from GitHub.
2. Correct the application contract:
   ```text
   woundsAfter = max(0, woundsBefore - finalDamage)
   criticalValue = max(0, finalDamage - woundsBefore)
   ```
3. Store `criticalValue` in the application transaction without changing the immutable original damage calculation.
4. Update chat/application presentation so a positive overflow clearly says that it produced a critical value, while remaining Wounds stay at zero.
5. Decide safe normalization for any test Actors currently holding negative `system.status.wounds.value`.
6. Runtime-test:
   - damage below remaining Wounds;
   - exact damage to zero;
   - overflow damage producing critical value;
   - damage to an Actor already at zero;
   - GM and target OWNER permissions;
   - double-application protection.
7. After this passes, implement standalone `Upadek` as the next real damage producer.
8. After Upadek, audit and build the dedicated Critical Hit Chart subsystem rather than encoding critical injuries as negative Wounds.

---

# Important cautions

- Foundry runtime validation is definitive.
- If `system.json` changes, perform a full Foundry restart.
- Read back startup/import-critical files after replacement.
- No WFRP mechanic is implemented from memory alone.
- English Core Rulebook controls mechanics; Polish Core Rulebook controls terminology and is checked for differences.
- Do not apply damage at roll-calculation time.
- Do not use negative Wounds as critical-state storage.
- Do not mutate persistent ActiveEffect state for per-roll choices.
- Do not auto-delete historical duplicate Skills.
- Avoid touching confirmed Active Effect persistence unless a concrete defect requires it.
- Preserve ActiveEffect compatibility subtype support until old world data has been safely audited/migrated.

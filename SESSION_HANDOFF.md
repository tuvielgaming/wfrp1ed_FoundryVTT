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
4. Full damage application permission matrix: GM, target OWNER, non-owner denial.
5. Double-application protection.
6. Remaining/max Wounds display on the Classic sheet.
7. Wounds floor at zero during new damage application.
8. Manual current-Wounds editing on the Classic sheet.
9. Manual Wounds permission split:
   - GM always allowed;
   - explicit Actor OWNER locked by default;
   - GM can temporarily unlock/re-lock OWNER manual editing;
   - non-owner remains blocked;
   - normal OWNER `Zastosuj obrażenia` remains independent from the manual-edit lock.
10. Bilingual WFRP 1e movement audit for Zeskok / Upadek / Skok.
11. Zeskok integrated into the generic damage workflow and runtime-confirmed.

Latest confirmed Wounds-permission fixes:

```text
111eae7551cfefbdbd804af7c9d54141bd562602
Restrict temporary Wounds editing to explicit Actor owners

40e4755c053f35f20c066b114ddf4d98d8d47950
Keep Wounds permission control inside Classic cell

78732be5ad442e3aeca1dfeace7cfce1cc0acbbe
Refine Classic Wounds lock positioning and color
```

The user confirmed the final behavior works as intended.

---

# IMPORTANT RULE CORRECTION — Wounds never become negative

The English and Polish WFRP 1e Core Rulebooks were checked directly.

Verified sources:

- English Core Rulebook — Combat, Critical Hits / Critical Hit Chart, printed page 122.
- Polish Core Rulebook — Walka, Trafienia krytyczne / Tabela trafień krytycznych, printed page 122.

Canonical application rule:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

Rules conclusions:

- remaining Wounds/Żywotność stop at `0`;
- Wounds never become negative;
- excess damage from one hit becomes that hit's `criticalValue`;
- once at zero Wounds, later damage produces new per-hit critical values rather than accumulating negative Wounds.

Current runtime implementation stores:

```text
criticalValue
criticalMode
```

in the authoritative damage-application transaction.

`DamagePacket` currently supports critical routing values:

```text
unspecified
detailed
sudden-death
```

Legacy Actors created during the earlier negative-Wounds prototype are normalized toward the zero floor; no historical critical value is fabricated from an old negative total.

Key commits:

```text
7281a079b642bc5a76098dfa02adf20b01e35272
Correct Wounds floor and critical-hit overflow rules

062ed05
Add explicit critical routing to damage packets

4413fbe
Clamp Wounds and preserve critical overflow

3e98e91
Normalize legacy negative Wounds and expose critical modes
```

---

# Manual Wounds editing contract — CONFIRMED

The Classic `Żyw` cell displays current/max Wounds, e.g.:

```text
6/6
4/6
0/6
```

The persistent current value is:

```text
system.status.wounds.value
```

The maximum is derived from the current Wounds characteristic.

Current values are clamped to:

```text
0 <= remaining Wounds <= maximum Wounds
```

Manual editing permission is deliberately separate from normal Actor ownership gameplay permissions.

Per-Actor flag:

```text
flags.wfrp1ed.allowOwnerWoundsEdit
```

Rules:

- GM always receives the editable current-Wounds field.
- A non-GM must be an **explicitly assigned OWNER** on that Actor and the flag must be `true`.
- `default` ownership or broad world permissions do not grant the temporary manual-edit privilege.
- Non-owners remain blocked.
- GM lock/unlock changes re-render already-open Character sheets on connected clients.
- The GM lock icon is positioned inside the Żyw cell and uses a light-crimson accent.
- Authorized `DamageApplication` bypasses only the manual-edit lock after independently validating normal GM/OWNER damage permission.

Do not merge the manual-edit permission with Foundry user role/GM permissions.

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

Confirmed identity rule:

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

Active Effects remain system-wide WFRP rule descriptors, not Skill-only. Future weapons, armour, equipment, spells, diseases, traits/talents and other rule-bearing Items should consume the same stable rule-target language.

---

# Generic damage subsystem — CONFIRMED FOUNDATION

Architecture:

```text
damage-producing procedure/action
→ DamagePacket
→ DamageResolver
→ DamageResolution
→ explicit ChatMessage Zastosuj obrażenia
→ DamageApplication
→ Actor remaining Wounds + application transaction
```

Damage calculation and damage application are deliberately separate. Calculating damage never silently mutates an Actor.

Current files:

```text
module/damage/DamagePacket.mjs
module/damage/DamageResolution.mjs
module/damage/DamageResolver.mjs
module/damage/DamageApplication.mjs
module/damage/DamageChat.mjs
module/damage/DamageBootstrap.mjs
```

Runtime API:

```js
game.WFRP1ED.damage
```

`DamageResolver` currently resolves packets only when Armour and Toughness are explicitly ignored. Normal combat mitigation must not be invented before the corresponding bilingual combat audit.

## Damage application permission matrix — CONFIRMED

- GM can apply damage.
- Target Actor OWNER can apply damage.
- OWNER can apply damage from a GM-authored ChatMessage without owning the ChatMessage.
- Non-owner does not receive the action.
- Same packet cannot normally be applied twice.

Actor-side application transaction is authoritative because Actor ownership and ChatMessage ownership may differ.

Foundry v14 context menu compatibility uses:

```text
label
visible
onClick(event, target)
```

Confirmed callback adapter fix:

```text
c0adce4569e39f463b1c9169ed78e8fc94ec66d4
Fix Foundry v14 context menu callback adapter
```

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

- Acrobatics contributes +2 through stable Active Effect target `procedure.movement.jump.reductionDie`.
- Positive damage ignores Armour and Toughness.
- If damage is suffered, roll the 50% held-item drop check.
- Full-round procedure.
- Generic damage is attached to the same movement ChatMessage only when positive damage is produced.
- Damage is applied only through explicit `Zastosuj obrażenia`.
- Runtime-confirmed.

## Upadek

Verified formula:

```text
fallDamage = max(0, 2 * ceil(height) - (1d6 + reductionDieBonuses))
```

Standalone Upadek is not implemented yet.

## Skok

With run-up:

```text
distance = max(1, 2 * Movement - 1d6 + leapBonuses)
```

Without sufficient run-up:

```text
distance = max(1, 2 * Movement - 2d6 + leapBonuses)
```

If a Skok fails, the GM determines actual vertical fall height from the scene. Do not infer vertical fall height from horizontal gap distance.

---

# Critical resolution rules — VERIFIED ARCHITECTURAL DISTINCTION

Two critical paths must remain separate.

## Detailed combat criticals

Normal combat overflow uses the detailed Critical Hit process:

```text
criticalValue + d100
→ Critical Hit Chart
→ effect number
→ hit-location Critical Effect
```

The detailed path requires hit-location context.

## Sudden Death / Nagła Śmierć

The simplified Sudden Death table is distinct from the detailed combat chart.

It is used as an optional simplified critical system and for non-combat critical damage such as falls/bleeding where the rules direct that path.

Zeskok/Upadek critical overflow must route through:

```text
criticalMode: sudden-death
```

not the detailed combat chart.

Do not infer critical routing from localized source labels or Item names.

---

# Critical Table extension architecture — APPROVED

Critical tables are intended as a first-class modular extension surface.

WFRP1ED Core must provide audited default/fallback tables. Alternative or expanded tables should naturally be supplied by Foundry modules/expansions.

Stable resolution precedence:

```text
1. explicit world RollTable override
2. explicitly selected installed module/expansion provider
3. audited WFRP1ED Core fallback
```

Important rules:

- registering a module provider does **not** activate it;
- installation/activation of a module must never silently change campaign mechanics;
- GM explicitly selects a provider for a role;
- a missing/disabled provider falls back safely to Core;
- an invalid/deleted world override falls through to provider/Core;
- world RollTable override remains an advanced escape hatch for quick house-rule experimentation;
- serious/reusable alternate rules should normally live in an expansion/module;
- system defaults must not be edited in place by world customization.

Stable initial critical-table roles:

```text
critical.suddenDeath
critical.detailed.chart
critical.detailed.head
critical.detailed.body
critical.detailed.arm
critical.detailed.leg
```

Modules may later register additional roles for optional content where appropriate.

---

# Critical Table Registry — IMPLEMENTED, NOT YET RUNTIME-CONFIRMED

New files:

```text
module/criticals/CriticalTableRegistry.mjs
module/criticals/CriticalBootstrap.mjs
```

Commits:

```text
ae31c917d10e1dbdd8b8af74abf88354e5adeb74
Add critical table registry contract

369779a31f50dbe7eba133ced82538a895cb7e7d
Expose critical table provider API

00c3b2151995bbd66bc792e6c6f269f739d94b48
Load critical table registry bootstrap
```

The registry currently provides:

- stable role registration;
- provider registration;
- Core-vs-module provider source distinction;
- module-active availability check;
- hidden world-scoped configuration setting;
- GM-only provider selection;
- GM-only explicit world RollTable override;
- fallback resolution order;
- invalid/missing configured source warnings;
- snapshot/inspection API;
- module registration hook:

```text
wfrp1edRegisterCriticalTableProviders
```

Runtime API after successful startup should be:

```js
game.WFRP1ED.criticals.roles
game.WFRP1ED.criticals.providerSource
game.WFRP1ED.criticals.registry
```

No actual Core RollTable provider has been registered yet. `resolve(role)` is expected to fail with a clear missing-Core-provider error until the audited Core tables are created and registered.

Do not encode Sudden Death percentages from memory. Verify exact English/Polish table contents before creating the Core provider.

---

# Startup regression caution — IMPORTANT

A prior persistence experiment caused Character and Skill documents to fall back to Foundry `BaseSheet` because of a syntax error in `RuleEffectResolver.mjs`.

Historical error:

```text
Private field '#collectEffect' must be declared in an enclosing class
```

Fix commit:

```text
e527d61b4702f32a093d8ef9c6fe3a2cb88140d1
Fix RuleEffectResolver class structure
```

Rules:

- read back startup/import-critical files after replacement;
- if `system.json` changes, perform a full Foundry restart;
- hot refresh is not proof of clean startup;
- do not reintroduce old ActiveEffect subtype migration behavior.

A small ActiveEffect `wfrp` compatibility declaration still exists because old world documents may have been created during the earlier subtype experiment. Do not remove it casually.

---

# CURRENT NEXT TASK — start here

The Critical Table Registry has just been added but is **not yet runtime-tested**.

Next steps:

1. `git pull` and fully restart Foundry because `system.json` changed.
2. Confirm Character and Skill sheets still register/open normally.
3. Inspect:
   ```js
   game.WFRP1ED.criticals.registry.snapshot()
   ```
   Expected: six registered roles, zero providers, empty configuration.
4. Confirm the registry setting exists and startup has no console errors.
5. After this passes, inspect the uploaded English + Polish Sudden Death tables directly and transcribe/audit the exact ranges.
6. Implement the audited WFRP1ED Core Sudden Death RollTable/provider.
7. Register it as the Core fallback for `critical.suddenDeath`.
8. Connect Zeskok critical overflow to that role and test the complete flow.
9. Then implement standalone Upadek using the already-audited falling damage formula and the same Sudden Death route.
10. Detailed combat Critical Hit tables remain a later dedicated slice because they require the detailed chart plus hit-location effect tables.

---

# Important cautions

- Foundry runtime validation is definitive.
- No WFRP mechanic is implemented from memory alone.
- English Core Rulebook controls mechanics; Polish Core Rulebook controls terminology and is checked for differences.
- Do not apply damage at roll-calculation time.
- Do not use negative Wounds as critical-state storage.
- Do not mutate persistent ActiveEffect state for per-roll choices.
- Do not auto-delete historical duplicate Skills.
- Avoid touching confirmed Active Effect persistence unless a concrete defect requires it.
- Preserve ActiveEffect compatibility subtype support until old world data has been safely audited/migrated.
- Module provider registration and world activation must remain separate concerns.

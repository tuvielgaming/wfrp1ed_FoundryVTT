# Session Handoff

**Date:** 2026-08-11  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change.

The latest user commit observed before the detailed-critical branch was created is:

```text
91b3fd95b3d4300b51ef1cd0a45fecff19249892
Small Wound lock marker alignment
```

That commit only adjusts the Classic Wounds lock marker in `css/sheets/classic-wounds.css` (`top/right` and red color). Preserve it.

The current development branch for the next subsystem is:

```text
feature/detailed-critical-wounds
```

It was created from `91b3fd95b3d4300b51ef1cd0a45fecff19249892`.

---

# Runtime-confirmed foundations

The user has live-tested the following in Foundry v14 and reported them working unless a narrower caveat is stated below.

## Character / Wounds

- Character characteristics use the native Character TypeDataModel.
- Remaining Wounds are persistent and bounded at zero during damage application.
- Damage overflow is stored as per-hit `criticalValue`; negative Wounds are not used as critical-state storage.
- Classic sheet shows remaining/max Wounds.
- Manual Wounds editing is protected by the explicit GM/owner permission workflow.
- The user's latest Wounds lock marker alignment commit must not be overwritten.

Canonical damage boundary remains:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

## Damage

- Generic immutable `DamagePacket` + `DamageResolver` flow exists.
- Damage is applied explicitly from ChatMessage state, not automatically at roll time.
- Damage application permission is GM OR target Actor OWNER.
- Double application is protected.
- Critical routing is explicit on `DamagePacket`:
  - `unspecified`
  - `detailed`
  - `sudden-death`

## Sudden Death criticals

The explicit Sudden Death lifecycle is runtime-confirmed:

```text
damage applied
→ pending Sudden Death state
→ explicit Resolve Critical action
→ real 1d100 roll
→ Actor-authoritative resolution persisted
→ separate critical result ChatMessage
```

Presentation normalizes raw overflow to the printed tier, for example:

```text
Nagła Śmierć +6
```

Do not display a second `Tabela +6+` or raw overflow metadata.

Permissions remain deliberately separate:

- damage application: GM OR target OWNER;
- critical resolution: GM OR source/damage-message creator;
- Fate spending: GM OR target OWNER.

## Fatal result + Fate

Runtime flow confirmed:

```text
fatal Sudden Death result
→ defeated/dead status overlay
→ eligible GM/OWNER spends one Punkt Przeznaczenia
→ Fate decreases by 1
→ defeated status removed
→ original fatal critical result remains historical fact
```

Spending Fate does not heal Wounds; the Actor may remain at 0 Wounds.

Classic page 2 now presents one visible **Punkty Przeznaczenia** value. The internal CharacterData still temporarily stores `fate.value` and `fate.max` and the sheet synchronizes them. That internal pair is technical debt; do not expose current/max as WFRP 1e UI.

## Luck / Szczęście

Official identity:

```text
rulesId: luck
English: Luck
Polish: Szczęście
```

The generic WFRP 2e-style `fortune` resource must not be reintroduced.

Runtime-confirmed behavior:

- GM performs one global daily reset workflow.
- Players group is selected by default; NPC/Monsters is optional.
- Each selected Actor with Luck receives a secret `1d6` daily allowance.
- Allowance rolls use GM-only visibility and are not visible to players.
- Players never receive the hidden allowance/remaining count.
- `d100/K100` Luck supports ±10 where the result provider exposes it.
- `d6/K6` Luck supports ±1 where the result provider exposes it.
- Luck may be used repeatedly on the same physical roll while daily uses remain; every use consumes one allowance.
- History is append-only (`luckHistory`) rather than keyed by dotted roll IDs.
- The original Foundry Roll remains the physical roll; effective values are recalculated and audited separately.

## Movement

Audited core movement terminology:

```text
Jumping = Zeskok
Falling = Upadek
Leaping = Skok
```

Runtime-confirmed:

- Zeskok calculation and generic damage integration.
- Skok calculation.
- Luck can re-resolve the useful movement die safely before irreversible downstream consequences.
- Per-client movement chat localization works from persisted neutral mechanical state.

Still missing:

- standalone `Upadek / Falling` procedure.

## Held-items consequence

The old automatic held-items K100 was removed from Zeskok.

Current runtime-confirmed lifecycle:

```text
Zeskok K6
→ player may still use Luck
→ if final result causes Wounds, show "Roll held-items check"
→ click finalizes the Zeskok for this dependent consequence
→ create a separate real 1d100 ChatMessage
→ 01–50 drops held items / 51–100 retains them
→ Luck +10 may modify the separate K100 repeatedly while useful
```

If Luck reduces Zeskok damage to zero before the held-items check starts, the button disappears.

The held-items result already stores a pending consequence contract for `drop-held-items`, but **automatic application is intentionally not implemented yet** because the current Item model has no canonical `held/equipped` state. Do not create a fake Apply action which does not actually alter held equipment.

## Per-client chat localization

System result cards now use persisted mechanical state and a render-time localization layer where implemented. Different connected users may see the same system ChatMessage in their own UI language.

Do not translate authored campaign content (custom Item names/descriptions) automatically.

---

# Detailed Critical Wounds — current next subsystem

This is the major feature that was paused while Fate/Luck/movement issues were fixed.

## Existing architecture already present

`CriticalTableRegistry` already defines stable roles:

```text
critical.detailed.chart
critical.detailed.head
critical.detailed.body
critical.detailed.arm
critical.detailed.leg
```

The detailed chart role supports the same critical-value variants used by the critical matrix:

```text
+1, +2, +3, +4, +5, +6+
```

This registry/provider boundary should be kept. Optional modules may register alternate providers without silently activating them.

## What is NOT implemented yet

Current source has no complete detailed-critical lifecycle:

- no WFRP1ED Core provider for the detailed critical roles;
- no materialized Core detailed RollTables;
- no detailed critical resolver;
- no detailed result ChatMessage workflow;
- no `criticalWound` Item type;
- no Critical Wound TypeDataModel;
- no dedicated Critical Wound Item sheet;
- no conversion of a resolved detailed result into a real Actor-owned wound Item;
- no Active Effect construction for mechanical consequences;
- no recovery/removal lifecycle for those effects.

Sudden Death must remain a separate subsystem. Do not merge fatal Sudden Death table handling into the detailed wound Item path.

## Approved target architecture

The previously agreed direction remains:

```text
applied damage with critical.mode = detailed
→ detailed critical chart resolution
→ location-specific detailed effect resolution
→ separate roll-bearing result ChatMessage
→ real Critical Wound Item representing the resolved injury
→ native embedded Active Effects for mechanical consequences when the rule requires them
→ Item can persist on / be assigned to an Actor
→ recovery/removal updates or removes the wound/effects through normal Documents
```

The Item represents persistent injury state. Chat messages represent the historical resolution event. Do not use ChatMessage flags as the only long-term injury store.

## Rulebook gate

The existing audit previously verified the general Critical Hits / Critical Hit Chart section at printed page 122 in both Core Rulebooks, but the exact detailed effect tables and their complete persistent consequences must be reopened before we encode them.

Project rule remains:

- English Core Rulebook controls mechanics;
- Polish Core Rulebook controls official Polish terminology and is checked for differences;
- no detailed wound effect is implemented from memory or a fan source.

If the official PDFs are not searchable in the active session, request/recover those exact files before materializing detailed Core tables or authoring effect rules.

---

# Other intentionally open work

These are not the immediate task but must not be forgotten:

1. Standalone `Upadek / Falling` movement procedure.
2. Real held/equipped equipment state and application of `drop-held-items` consequence.
3. Fate internal model cleanup from transitional `{value,max}` to the final one-value WFRP 1e contract, with migration.
4. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

---

# Immediate next steps

1. Re-open current detailed-critical source files and registry contracts from current GitHub.
2. Re-open the exact English and Polish detailed critical-effect rulebook sections.
3. Document the persistent injury contract in `RULEBOOK_IMPLEMENTATION.md` without duplicating this handoff.
4. Implement the smallest dependency-first slice:
   - Critical Wound Item type + native TypeDataModel;
   - Item-sheet/document lifecycle needed to inspect the wound and its Active Effects;
   - no table content until exact rule data is verified.
5. Then implement Core detailed tables/resolver and connect resolved results to wound Items.
6. Runtime-test each slice in Foundry before calling it complete.

---

# Persistent project cautions

- Foundry runtime validation by the user is definitive.
- Fetch current GitHub source before every edit.
- Preserve user commits made between assistant sessions.
- Use native Foundry v14 APIs and document lifecycle.
- Never use negative Wounds for critical state.
- Do not apply damage at roll-calculation time.
- Preserve the original physical roll when post-roll mechanics modify an effective result.
- Avoid irreversible downstream consequences until post-roll interventions are finished.
- Resolve synthetic/token Actors before world prototypes when a ChatMessage identifies a token.
- Do not infer rule identity from localized Item names; use stable IDs.
- Keep damage, critical-resolution and Fate permissions separate.
- Do not create placeholder automation that claims to apply a consequence when the underlying persistent model cannot represent it.

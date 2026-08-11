# Session Handoff

**Date:** 2026-08-11  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change and preserve user commits made between assistant turns.

Latest user-authored commit observed before this handoff update:

```text
39a9b2bb288e74f5e451fcde9e08780b67806ec6
Crit wound placement
```

It changes only `css/sheets/classic-health.css`, moving the Critical Wounds health-category launcher upward (`bottom: 7px` → `bottom: 20px`). Preserve it.

Earlier user-authored Wounds adjustment that must also remain preserved:

```text
91b3fd95b3d4300b51ef1cd0a45fecff19249892
Small Wound lock marker alignment
```

---

# Runtime-confirmed foundations

The user has live-tested the following in Foundry v14 and reported them working.

## Wounds / damage

- Remaining Wounds are persistent and stop at zero during damage application.
- Per-hit overflow is stored as `criticalValue`; negative Wounds are not critical-state storage.
- Classic sheet shows remaining/max Wounds and protects manual editing.
- Generic immutable `DamagePacket` + `DamageResolver` flow exists.
- Damage is applied explicitly from ChatMessage state.
- Damage permission: GM OR target Actor OWNER.
- Double application is protected.
- Critical routing distinguishes `unspecified`, `detailed`, and `sudden-death`.

Canonical damage boundary:

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

Fatal result:

```text
Killed / Śmierć
→ defeated/dead overlay
→ GM or target OWNER may spend one Fate Point
→ Fate -1
→ defeated status removed
```

Spending Fate does not heal Wounds.

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
- Players do not see the hidden daily pool rolls.
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
- actual application of `drop-held-items`, blocked until equipment has a canonical held/equipped state.

---

# Detailed Critical Wounds — active subsystem

This is the feature resumed after the Fate/Luck/movement detour.

## Existing registry architecture

`CriticalTableRegistry` already defines:

```text
critical.detailed.chart
critical.detailed.head
critical.detailed.body
critical.detailed.arm
critical.detailed.leg
```

Detailed critical variants use the shared critical-value contract (`+1` through `+6+`). Keep the provider/registry boundary intact. Sudden Death remains a separate subsystem.

## Approved lifecycle

```text
applied damage with critical.mode = detailed
→ detailed critical resolution
→ separate roll-bearing result ChatMessage
→ real Critical Wound Item representing persistent injury
→ native embedded ActiveEffects for ongoing mechanical consequences
→ Item persists on / is assigned to an Actor
→ recovery/removal operates through normal Documents
```

ChatMessage = historical resolution event.  
Critical Wound Item = persistent injury state.

---

# Critical Wound Item foundation — IMPLEMENTED AND RUNTIME-CONFIRMED

Implemented foundation:

```text
module/data-models/item/CriticalWoundData.mjs
module/sheets/CriticalWoundItemSheet.mjs
templates/item/critical-wound-sheet.hbs
css/sheets/critical-wound-item.css
```

The `criticalWound` Item subtype is registered in `system.json`, backed by a native Foundry v14 `TypeDataModel`, and has a dedicated `ItemSheetV2`.

Persistent rule-neutral fields currently include:

```text
description
criticalValue
hitLocation
resolution.damagePacketId
resolution.sourceMessageId
resolution.resultMessageId
resolution.tableRole
resolution.tableVariant
resolution.providerId
resolution.tableUuid
resolution.tableResultId
resolution.roll
resolution.resolvedByUserId
resolution.resolvedAt
```

No speculative penalty/duration/bleeding/amputation fields were added.

Ongoing mechanical consequences belong to normal Item-embedded Foundry `ActiveEffect` Documents. The wound sheet can list, create, open, enable/disable and delete those effects.

The user confirmed that the wound Item sheet and embedded Active Effect lifecycle work correctly.

---

# Psychika i zdrowie / Actor-side health-category UI — IMPLEMENTED AND RUNTIME-CONFIRMED

The Classic sheet now uses the **Psychika i zdrowie** area as the launcher space for persistent health categories.

Current implemented category:

```text
Rany krytyczne / Critical Wounds
```

Architecture:

```text
Psychika i zdrowie
→ compact category button/tag with current count
→ category-specific Foundry window
→ list of Actor-owned Items of that category
→ category-specific actions and lifecycle
```

The current Critical Wounds window supports:

- listing Actor-owned `criticalWound` Items;
- showing the wound count on the Classic-sheet category launcher;
- creating a new embedded Critical Wound;
- opening the embedded wound in its dedicated wound sheet;
- removing the wound from the Actor;
- retaining/removing the wound's embedded Active Effects through the normal Item document lifecycle.

The user runtime-tested and confirmed that this works as described.

The user also manually adjusted the category launcher position in commit `39a9b2bb288e74f5e451fcde9e08780b67806ec6`; preserve that visual placement.

This UI pattern is intentionally extensible. Future categories such as Diseases/Choroby, Mutations/Mutacje, etc. should receive their own category button/tag and their own purpose-built window when their Item contracts are actually implemented. Do not add fake/inert categories before the corresponding subsystem exists.

---

# Rulebook gate before actual detailed table mechanics

The general Critical Hits / Critical Hit Chart section was previously audited at printed page 122 in both Core Rulebooks, but the exact detailed effect rows and persistent consequences must be reopened before they are encoded.

The active GitHub repository does not contain the Core PDFs and the current accessible uploaded-file sources did not recover them during this session.

Therefore do **not** materialize detailed Core RollTables, penalties, durations, bleeding, amputations, recovery rules, or other wound-specific effects from memory or fan material.

Before the next mechanics slice, recover/upload the exact English and Polish WFRP 1e Core Rulebook PDFs (or a repository/archive snapshot containing them).

Policy:

- English Core Rulebook controls mechanics;
- Polish Core Rulebook controls official Polish terminology and is checked for differences.

---

# Immediate next steps

1. At the start of the next session, fetch current `master` first and preserve any user changes made after this handoff.
2. Recover/open the English and Polish Core Rulebook detailed critical-effect tables.
3. Update `RULEBOOK_IMPLEMENTATION.md` with the verified detailed injury contract and repair any stale status statements there.
4. Define/materialize the WFRP1ED Core provider for the detailed critical registry roles.
5. Implement the detailed resolver and separate roll-bearing result ChatMessage.
6. Convert a resolved detailed result into a real Actor-owned `criticalWound` Item using the already runtime-confirmed Psychika i zdrowie / Critical Wounds lifecycle.
7. Generate only verified native ActiveEffects required by the exact resolved injury.
8. Runtime-test before implementing recovery/removal automation.

---

# Other intentionally open work

1. Standalone `Upadek / Falling`.
2. Canonical held/equipped equipment state + real `drop-held-items` application.
3. Fate internal `{value,max}` cleanup to the final one-value contract with migration.
4. Future Psychika i zdrowie categories such as Diseases and Mutations, only after their real Item/data contracts are audited.
5. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

---

# Persistent cautions

- Foundry runtime validation by the user is definitive.
- Fetch current GitHub source before every edit.
- Preserve user commits made between assistant sessions.
- Use native Foundry v14 APIs and Documents.
- Never use negative Wounds for critical state.
- Do not apply damage at roll-calculation time.
- Preserve the original physical roll when post-roll mechanics alter an effective result.
- Avoid irreversible downstream consequences until post-roll interventions are finished.
- Resolve synthetic/token Actors before world prototypes when a ChatMessage identifies a token.
- Do not infer mechanical identity from localized Item names; use stable IDs.
- Keep damage, critical resolution, Fate and consequence permissions separate.
- Do not create an Apply action unless the underlying persistent model can actually represent and perform the consequence.

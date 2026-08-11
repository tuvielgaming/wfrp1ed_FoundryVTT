# Session Handoff

**Date:** 2026-08-11  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change.

The user's latest pre-critical commit is:

```text
91b3fd95b3d4300b51ef1cd0a45fecff19249892
Small Wound lock marker alignment
```

It adjusts only the Classic Wounds lock marker in `css/sheets/classic-wounds.css`. Preserve it.

The detailed-critical foundation was developed from that exact commit on:

```text
feature/detailed-critical-wounds
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
- Critical routing already distinguishes `unspecified`, `detailed`, and `sudden-death`.

Canonical damage boundary:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

## Sudden Death / Fate

Runtime-confirmed flow:

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

The Classic sheet exposes one visible **Punkty Przeznaczenia** value. Internal `fate.value/max` remains transitional technical debt and must not be exposed as a WFRP 1e current/max UI.

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
- Player never receives allowance/remaining count.
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
- if Luck reduces Zeskok damage to zero before the dependent check, the button disappears.
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

Detailed critical variants are already represented by the shared critical variant contract (`+1` through `+6+`). The provider/registry boundary must remain intact.

Sudden Death remains a separate subsystem and must not be merged into detailed wounds.

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

# Critical Wound Item foundation — IMPLEMENTED, runtime test required

The architecture-only foundation is now implemented without inventing unverified table mechanics.

Added:

```text
module/data-models/item/CriticalWoundData.mjs
module/sheets/CriticalWoundItemSheet.mjs
templates/item/critical-wound-sheet.hbs
css/sheets/critical-wound-item.css
```

Updated:

```text
module/wfrp1ed.mjs
system.json
```

The manifest now registers Item subtype:

```text
criticalWound
```

`CONFIG.Item.dataModels.criticalWound` is backed by the native `CriticalWoundData` TypeDataModel and a dedicated `ItemSheetV2` is registered for that subtype.

The persistent model currently stores only rule-neutral resolution facts:

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

Ongoing mechanical consequences belong to normal Item-embedded Foundry `ActiveEffect` Documents. The Critical Wound sheet can list, create, open, enable/disable and delete those native effects. Generated table-specific effects will be authored later by the audited resolver.

This direction is compatible with Foundry v14's native Item/ActiveEffect relationship and ItemSheetV2 lifecycle.

## Required runtime smoke test

After the branch is moved to `master`, perform a full Foundry/world restart because `system.json` changed.

Verify:

1. system starts without manifest/import errors;
2. `Item.TYPES`/Item creation includes `criticalWound`;
3. create one blank Critical Wound Item;
4. its dedicated sheet opens;
5. edit name, critical value, location and description, close/reopen, verify persistence;
6. add a native Active Effect from the wound sheet;
7. close/reopen and verify the effect remains embedded;
8. if the wound is embedded on an Actor, verify a transfer-enabled effect behaves as a normal Item effect.

Do not call this foundation runtime-confirmed until the user performs that test.

---

# Rulebook gate before actual detailed table mechanics

The general Critical Hits / Critical Hit Chart section was previously audited at printed page 122 in both Core Rulebooks, but the exact detailed effect rows and persistent consequences must be reopened before they are encoded.

The active GitHub repository does not contain the Core PDFs and the current File Library search did not recover them.

Therefore do **not** materialize detailed Core RollTables, penalties, durations, bleeding, amputations, recovery rules, or other wound-specific effects from memory/fan material.

Before the next mechanics slice, recover/upload the exact English and Polish WFRP 1e Core Rulebook PDFs (or the repository ZIP/snapshot containing them).

Policy:

- English Core Rulebook controls mechanics;
- Polish Core Rulebook controls official Polish terminology and is checked for differences.

---

# Next implementation after rulebook recovery

1. Re-open the exact detailed critical chart/effect table sections in both books.
2. Update `RULEBOOK_IMPLEMENTATION.md` with the verified detailed injury contract and repair its stale old status statements.
3. Define/materialize the WFRP1ED Core provider for the detailed critical registry roles.
4. Implement the detailed resolver and separate result ChatMessage.
5. Convert a resolved detailed result into a real `criticalWound` Item plus verified native ActiveEffects.
6. Runtime-test before adding recovery/removal automation.

---

# Other intentionally open work

1. Standalone `Upadek / Falling`.
2. Canonical held/equipped equipment state + real `drop-held-items` application.
3. Fate internal `{value,max}` cleanup to the final one-value contract with migration.
4. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

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

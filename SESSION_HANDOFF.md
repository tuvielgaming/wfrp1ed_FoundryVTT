# Session Handoff

**Date:** 2026-08-11  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change and preserve user commits made between assistant turns.

User-authored visual adjustments which must remain preserved:

```text
39a9b2bb288e74f5e451fcde9e08780b67806ec6
Crit wound placement
```

Changes only `css/sheets/classic-health.css`, moving the Critical Wounds launcher upward (`bottom: 7px` → `bottom: 20px`).

```text
91b3fd95b3d4300b51ef1cd0a45fecff19249892
Small Wound lock marker alignment
```

---

# Runtime-confirmed foundations

## Wounds / damage

- Remaining Wounds persist and stop at zero.
- Per-hit overflow is `criticalValue`; negative Wounds are never critical-state storage.
- Classic sheet shows remaining/max Wounds and protects manual editing.
- Generic immutable `DamagePacket` + `DamageResolver` flow exists.
- Damage is applied explicitly from ChatMessage state.
- Damage permission: GM OR target Actor OWNER.
- Double application is protected.
- Critical routing distinguishes `unspecified`, `detailed`, and `sudden-death`.

Canonical boundary:

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

Fatal result applies the defeated/dead overlay. GM or target OWNER may spend one Fate Point to avert death; Fate decreases by one and defeated status is removed. Spending Fate does not heal Wounds.

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
- actual `drop-held-items` application, blocked until equipment has a canonical held/equipped state.

---

# Critical Wound persistent state — IMPLEMENTED AND RUNTIME-CONFIRMED

Implemented:

```text
module/data-models/item/CriticalWoundData.mjs
module/sheets/CriticalWoundItemSheet.mjs
templates/item/critical-wound-sheet.hbs
css/sheets/critical-wound-item.css
module/sheets/CriticalWoundsWindow.mjs
module/health/HealthCategoryIntegration.mjs
```

The `criticalWound` Item subtype is a native Foundry v14 TypeDataModel with a dedicated ItemSheetV2. The user confirmed the Item sheet and embedded Active Effect lifecycle work correctly.

The Classic sheet uses **Psychika i zdrowie** as a compact launcher area. Current implemented category:

```text
Rany krytyczne / Critical Wounds
```

The user runtime-confirmed that the category window lists, creates, opens and removes Actor-owned `criticalWound` Items, displays the count, and that dragging a world Critical Wound Item onto an Actor makes it available there.

Future Diseases/Choroby, Mutations/Mutacje, etc. should get their own launcher and purpose-built window only when their real Item/data contract exists.

### CriticalWoundData provenance

Current rule-neutral persistent fields:

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

No speculative bleeding/amputation/recovery fields were added. Ongoing mechanical consequences belong to embedded native Active Effects once their consumer contracts are implemented.

---

# Critical Wound materialization boundary — IMPLEMENTED, FULL PATH NOT YET RUNTIME-CONFIRMED

Implemented:

```text
module/criticals/CriticalWoundApplication.mjs
```

Exposed as:

```text
game.WFRP1ED.criticals.wounds
```

It converts an already-resolved critical result into one Actor-owned `criticalWound` Item. It is rule-neutral: it does not choose tables or interpret injuries.

It enforces GM/target-OWNER permission, requires resolution provenance, accepts verified embedded ActiveEffect source objects, and prevents sequential duplicate materialization from the same result ChatMessage.

The underlying Actor-owned wound workflow is runtime-confirmed; the automatic result→materializer connection below still needs runtime testing.

---

# Detailed Critical Hit rulebook audit — VERIFIED

The user supplied `WFRP Core RuleBooks(6).zip` containing both Core Rulebooks. The detailed tables were visually re-audited from the scans.

### English Core Rulebook

- Combat — **Critical Hits / Critical Hit Chart / Critical Effects**, printed pp. **122-124**.

### Polish Core Rulebook

- Walka — **Trafienia krytyczne / Tabela trafień krytycznych / Efekty trafień krytycznych**, printed pp. **122-124**.

The English and Polish editions agree mechanically for the audited detailed chart/effects. English controls mechanics; Polish controls official terminology.

Verified chart contract:

```text
D100       +1  +2  +3  +4  +5  +6+
01-10       1   3   5   7  11* 14*
11-20       2   4   6   9* 13* 15
21-30       3   5   8* 14* 16  16
31-40       4   7  10* 13* 15  15
41-50       5   9* 14* 16  16  16
51-60       7  12* 15  15  15  15
61-70       9* 16  16  16  16  16
71-80      11* 15  15  15  15  15
81-90      16  16  16  16  16  16
91-00      15  15  15  15  15  15
```

`*` means the victim must flee combat if possible.

The four numbered effect families are:

```text
Arm / Ramię
Head / Głowa
Body / Korpus
Leg / Noga
```

Each has effects 1-16. Immediate-fatal Core rows verified and represented structurally are:

```text
Arm: 15, 16
Head: 14, 15, 16
Body: 14, 15, 16
Leg: 15, 16
```

Delayed/conditional death rows are not marked as immediate `killed`.

Important Core rule: once Wounds reach zero, additional Wounds from critical effects are not accumulated as negative Wounds; each such later loss is checked as the appropriate Sudden Death critical for that round.

---

# Core detailed critical tables/resolver — IMPLEMENTED, RUNTIME TEST REQUIRED

New implementation on the current detailed-critical slice:

```text
module/criticals/CoreDetailedCriticalTables.mjs
module/criticals/DetailedCriticalResolver.mjs
module/criticals/DetailedCriticalIntegration.mjs
templates/chat/detailed-critical-result.hbs
```

`CriticalBootstrap.mjs` now registers/materializes the Core detailed providers alongside Sudden Death.

## Managed Core tables

The GM-ready hook materializes ten read-only system-managed RollTables:

```text
6 × Critical Hit Chart variants: +1, +2, +3, +4, +5, +6+
1 × Arm effects
1 × Head effects
1 × Body effects
1 × Leg effects
```

The chart stores stable structured result flags (`effectNumber`, `flee`) so mechanics are never parsed from localized table text. Effect tables store stable location/effect-number/outcome flags. World/module overrides remain supported through `CriticalTableRegistry`.

## Detailed resolver

`DetailedCriticalResolver`:

1. requires a positive `criticalValue`;
2. requires canonical humanoid hit location (`head`, `rightArm`, `leftArm`, `body`, `rightLeg`, `leftLeg`);
3. resolves the correct +1…+6+ chart provider;
4. performs one real d100 roll;
5. reads the numbered effect from structured chart data;
6. resolves the matching Arm/Head/Body/Leg effect table;
7. returns a language-neutral resolution snapshot plus provider/table/result provenance.

## Chat/application lifecycle

Intended current flow:

```text
applied damage with critical.mode = detailed and criticalValue > 0
→ source damage card exposes Resolve Detailed Critical
→ real 1d100
→ Actor-authoritative detailed resolution
→ separate roll-bearing detailed result ChatMessage
→ result is localized per viewing client
→ nonfatal result offers Apply Critical Wound to GM/target OWNER
→ exactly one Actor-owned criticalWound Item via CriticalWoundApplication
→ visible under Psychika i zdrowie / Rany krytyczne
```

Immediate-fatal detailed results use `outcome: killed` and the existing fatal/Fate lifecycle instead of offering persistent wound materialization.

### Deliberately not automated in this slice

The exact table text is preserved in the Critical Wound description, but ongoing consequences such as:

- per-round bleeding;
- temporary inability to attack/parry/move;
- characteristic penalties;
- unconsciousness;
- amputation state;
- recovery-until-medical-attention;
- forced Sudden Death routing for later criticals;

are **not yet converted into Active Effects or timers**. The current rule-effect registry does not yet have canonical consumers for all of these. Do not encode them as arbitrary Actor data paths or fake Apply actions.

Next dependency after the resolver/materialization path is runtime-confirmed: define the minimal stable consequence/effect contracts needed by the verified Core rows, then generate embedded Active Effects from those structured contracts.

---

# Required next runtime test

1. Full Foundry/world restart so GM-ready can create the managed Core detailed tables.
2. Verify six detailed chart tables plus four location-effect tables appear without startup errors.
3. Create/apply a damage packet with `criticalMode: detailed`, positive overflow, and canonical humanoid hit location.
4. Verify the source card offers **Resolve Detailed Critical / Rozstrzygnij szczegółowe trafienie krytyczne**.
5. Resolve it and confirm a real d100 plus separate detailed result card with hit location, effect number/text and starred flee note when applicable.
6. On a nonfatal result, GM or target OWNER applies the wound; confirm exactly one new Critical Wound appears under Psychika i zdrowie and repeated application does not duplicate it.
7. Test an immediate-fatal detailed row; confirm defeated status/Fate integration works and no persistent-wound Apply action is offered.
8. Compare Polish and English clients for the same result card.
9. Regression-check existing Sudden Death.

Do not call this detailed critical path runtime-confirmed until the user completes the Foundry test.

---

# Documentation debt

`RULEBOOK_IMPLEMENTATION.md` still contains older status statements from before Wounds clamping, current Fate/Luck work and this detailed-critical audit. Do not trust its old implementation-status rows blindly. Update that existing document in place after this runtime slice; do not create a competing audit document.

---

# Other intentionally open work

1. Detailed Critical consequence/ActiveEffect contracts and recovery automation after current runtime confirmation.
2. Standalone `Upadek / Falling`.
3. Canonical held/equipped equipment state + real `drop-held-items` application.
4. Fate internal `{value,max}` cleanup to final one-value contract with migration.
5. Future Psychika i zdrowie categories such as Diseases and Mutations, only after real Item/data contracts are audited.
6. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

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
- Do not infer mechanical identity from localized names; use stable IDs/flags.
- Keep damage, critical resolution, Fate and consequence permissions separate.
- Do not create an Apply action unless the underlying persistent model can actually represent and perform the consequence.

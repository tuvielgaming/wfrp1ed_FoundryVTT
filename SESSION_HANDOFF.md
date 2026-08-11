# Session Handoff

**Date:** 2026-08-11  
**Purpose:** Current implementation/architecture checkpoint. Keep this as the single current handoff instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Primary branch: `master`

GitHub is the implementation source of truth. Fetch the exact current file before every code change and preserve user commits made between assistant turns.

Latest implementation commit before this handoff save:

```text
15bbd587f8cd5d7e1e3f45bd446369bee5bac9e2
```

Latest user-authored combat-sheet visual adjustment which must remain preserved:

```text
308b5fdd996a3683e67da68e096f0eb9c79cc347
Adjust melee wepon table top display
```

Earlier user-authored visual adjustments which must also remain preserved:

```text
39a9b2bb288e74f5e451fcde9e08780b67806ec6
Crit wound placement
```

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
- Players do not see hidden daily pool rolls.
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
- actual `drop-held-items` application. The new combat equipment state now gives us a canonical held/worn distinction, so this is no longer blocked by missing state, but application should wait until the unified inventory flow is stable.

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

---

# Detailed Critical Hits — RULEBOOK AUDITED, IMPLEMENTED, END-TO-END RUNTIME TEST DEFERRED

The user supplied both English and Polish WFRP 1e Core Rulebooks. Detailed Critical Hits / Trafienia krytyczne were visually audited from printed pp. 122–124 in both editions. English controls mechanics; Polish controls official terminology.

Implemented:

```text
module/criticals/CoreDetailedCriticalTables.mjs
module/criticals/DetailedCriticalResolver.mjs
module/criticals/DetailedCriticalIntegration.mjs
module/criticals/CriticalWoundApplication.mjs
templates/chat/detailed-critical-result.hbs
```

The GM-ready hook materializes ten managed Core RollTables:

```text
6 × Critical Hit Chart variants: +1, +2, +3, +4, +5, +6+
1 × Arm effects
1 × Head effects
1 × Body effects
1 × Leg effects
```

Intended lifecycle:

```text
real combat damage with critical.mode = detailed
→ apply damage
→ Resolve Detailed Critical
→ real d100
→ separate detailed result card
→ nonfatal result: Apply Critical Wound
→ exactly one Actor-owned criticalWound Item
→ visible under Psychika i zdrowie / Rany krytyczne
```

Immediate-fatal detailed results use the existing defeated/Fate lifecycle.

### Why runtime testing was deferred

A synthetic console smoke test exposed that Armour/Toughness mitigation is intentionally still unimplemented in `DamageResolver`. The first suggested console snippet also used the wrong nested `DamagePacket` constructor shape; the corrected constructor would use top-level `armour`, `toughness`, and `criticalMode` arguments.

Rather than continue with synthetic damage, the user chose to implement the real Weapon/Armour/combat dependencies first. This is now the active development path. Do **not** call the detailed critical end-to-end path runtime-confirmed yet.

Ongoing detailed-critical consequences such as bleeding, temporary incapacity, characteristic penalties, unconsciousness, amputation/recovery, and forced Sudden Death routing are still deliberately not automated until stable consequence/ActiveEffect consumer contracts exist.

---

# Combat equipment foundation — IMPLEMENTED, PARTIALLY RUNTIME-CONFIRMED

This became the active subsystem after detailed-critical resolution reached the real-combat dependency boundary.

## Native Weapon and Armour contracts

Implemented native Foundry v14 Item TypeDataModels and sheets for:

```text
weapon
armour
```

Key files include:

```text
module/data-models/item/InventoryItemFields.mjs
module/data-models/item/WeaponData.mjs
module/data-models/item/ArmourData.mjs
module/combat/CombatEquipment.mjs
module/combat/CombatEquipmentState.mjs
module/combat/CombatEquipmentBootstrap.mjs
module/combat/CombatSheetIntegration.mjs
module/sheets/WeaponItemSheet.mjs
module/sheets/ArmourItemSheet.mjs
templates/item/weapon-item-sheet.hbs
templates/item/armour-item-sheet.hbs
css/sheets/combat-item.css
css/sheets/classic-combat-equipment.css
```

### Canonical internal equipment state

Persistent physical Item state remains precise:

```text
state.mode = carried | held | worn
state.hand = none | right | left | both
```

User-facing combat UI deliberately simplifies this to **Carried / Used**:

```text
Used weapon  → held
Used shield  → held
Used armour  → worn
Not used     → carried
```

Do not collapse the internal held/worn distinction. It is needed by mechanics such as dropping held Items and armour protection, even though users should normally interact with a simpler two-state control.

### Weapon facts currently stored

- melee/ranged kind;
- ordinary/specialist/improvised group;
- handedness;
- parry suitability and main-rule parry bonus;
- optional Weapon Modifier values, stored but not automatically enabled;
- ranged short/long/max range;
- effective Strength;
- reload.

### Armour facts currently stored

- Armour class (Shield/Mail/Plate/Leather/Other);
- Armour Points;
- explicit coverage for six humanoid body locations;
- parry suitability and bonus for Shields;
- carried/held/worn state.

### Runtime checks already passed

Before the later UX fixes, the user confirmed the equipment resolver returned expected values in console tests, including active Armour totals and parry options.

Current resolver APIs include:

```text
game.WFRP1ED.equipment.resolver.armourAt(actor, location)
game.WFRP1ED.equipment.resolver.shieldArmour(actor)
game.WFRP1ED.equipment.resolver.parryOptions(actor)
```

`armourAt` includes active Shield AP for actual combat by default. Classic-sheet presentation may call it with `includeShields: false` because the printed sheet records Shield separately.

---

# Classic combat-sheet equipment UX — IMPLEMENTED, LATEST FIXES NEED RUNTIME CONFIRMATION

The page-1 printed tables now render Actor-owned Weapon and Armour Items.

Current behavior:

- Melee and ranged Weapons are shown in their printed tables.
- Armour Items are shown in the Armour table.
- Double-clicking a row opens the Item sheet.
- Small radio-style state control toggles Carried / Used.
- Trash icon removes the Item from the Actor after confirmation.
- carried rows are visually subdued; used rows are normal emphasis.
- positive optional melee modifiers display with `+`;
- negative modifiers retain `-`;
- zero displays as `-` instead of `0`.
- ranged Weapon sheet exposes short/long/max range, effective Strength, and reload.
- shared checkbox artwork now matches the Standard Test checkbox style across system-owned forms.

### Armour Point diagram

The six printed body-location boxes now show **worn non-Shield armour only**.

A separate derived Shield value is displayed in the printed shield symbol. Actual combat protection still includes an active Shield when `CombatEquipment.armourAt(...)` is called normally.

The user's latest screenshot showed Mail Shirt body protection and Shield value appearing in the intended separate places after restoring the Item data.

### Armour location presentation

Latest implementation at commit `15bbd587...` changes long Armour location text:

- full six-location coverage displays `Whole body / Całe ciało` instead of enumerating every location;
- partial multi-location coverage is allowed to wrap over multiple lines;
- full detail remains available in the tooltip.

This specific presentation change has **not yet been runtime-confirmed by the user**.

---

# Important bug fixes at the current checkpoint

## Carried / Used toggle data-loss bug

The initial toggle wrote only the dotted key:

```text
system.state.mode
```

Because WeaponData/ArmourData still contain compatibility migrations, this could cause omitted authored fields to be normalized to defaults during update cleaning. Runtime symptom: Armour Points and coverage disappeared after toggling Carried/Used even though the state itself changed.

Current fix in `CombatEquipmentState.mjs`:

```text
read complete current TypeDataModel source
→ change only state.mode in that full source
→ update the complete system object
```

The user's following screenshot showed restored AP/coverage and correct used-state presentation, but they did not explicitly declare this regression fully closed. Recheck it next session before treating it as runtime-confirmed.

## Classic-sheet scroll reset bug — LATEST FIX NOT YET RUNTIME-CONFIRMED

Problem: any Actor/owned-Item update caused the long two-page Classic sheet to jump back toward the top.

The first two attempted fixes were insufficient because the wrong scroller/lifecycle moment was captured.

Latest implementation in:

```text
module/sheets/ClassicSheetScrollPreservation.mjs
```

Current strategy:

```text
.wfrp1ed-classic-sheet is the actual scroll owner
→ continuously record its position on scroll events
→ also capture before rerender when possible
→ restore on the pending rerendered sheet
→ restore again on the next animation frame after live DOM insertion/layout
```

The user had **not yet tested this latest commit** when the session ended. Do not say scroll preservation works until runtime-confirmed.

Immediate first test next session:

1. scroll well down the Classic sheet;
2. edit Fate;
3. confirm position remains;
4. scroll elsewhere and toggle Weapon/Armour Carried/Used;
5. confirm position remains;
6. edit an owned combat Item and confirm the Actor sheet still retains its position.

If this still fails, inspect the live DOM for the actual element whose `scrollTop` changes and log the ApplicationV2 hook ordering rather than adding another speculative preservation layer.

---

# Approved inventory direction — NEXT FEATURE AFTER CURRENT FIXES ARE CONFIRMED

The user proposed, and we agreed, that page-2 **Ekwipunek / Equipment** should become the master physical inventory view.

Target UX:

```text
Page 2 Ekwipunek
→ normal Equipment + Weapons + Armour in one inventory list
→ primary Carried / Used radio-style state control
→ open/edit/delete actions
```

Then page-1 combat tables become **combat summaries**, not duplicate inventory managers:

```text
Broń ręczna      → only Used melee Weapons
Broń strzelecka  → only Used ranged Weapons
Zbroja            → only Used Armour/Shield Items
```

Important architecture decision:

- user-facing state stays simple: Carried / Used;
- internal `held` vs `worn` remains intact;
- do not hide Carried Items from page-1 combat tables until page-2 Ekwipunek is actually implemented, otherwise an Item could disappear from every useful sheet UI.

The `equipment` Item type still exists as an older/un-audited contract. Audit/normalize the physical Equipment model as part of this slice rather than building the page-2 inventory around stale placeholder fields.

After unified Ekwipunek is runtime-confirmed, remove or reduce redundant controls in the page-1 combat summaries as appropriate.

---

# Combat implementation path after inventory

Once the unified physical inventory is stable:

1. Audit and implement Combatant-level **Attacks / Ataki** turn resource.
   - Actor characteristic `A` defines the allowance.
   - spent attacks/parries are encounter/turn state on Combatant, not permanent Actor characteristic mutation.
2. Implement first melee attack transaction:

```text
choose target + used/held weapon
→ check remaining Attacks
→ WS test + audited modifiers
→ miss OR hit
→ hit location from reversed attack d100
→ defence opportunity
→ Parry / Dodge / none
→ damage roll
→ Strength + weapon
→ Toughness + armour by location
→ existing DamagePacket
→ Apply Damage
→ detailed/Sudden Death critical pipeline
```

3. Implement Parry/Dodge as responses to a pending incoming attack, not disconnected standalone rolls.
4. Then expand to charge, ranged attack/reload/range, surprise, fleeing, optional Weapon Modifiers, shields and other audited combat options.

The Core Weapon Modifiers table is optional. Storing modifier fields does not mean the optional rule is enabled.

---

# Documentation debt

`RULEBOOK_IMPLEMENTATION.md` still contains older implementation-status statements from before current Wounds/Fate/Luck/detailed-critical/combat-equipment work. Do not trust its old status rows blindly. Update that existing document in place after the current combat-equipment/inventory runtime slice; do not create a competing audit document.

---

# Other intentionally open work

1. Latest Classic scroll-preservation runtime verification.
2. Unified page-2 Ekwipunek master inventory.
3. Combatant Attacks/action economy and first real melee attack.
4. End-to-end runtime test of detailed Critical Wounds through real combat damage.
5. Detailed Critical consequence/ActiveEffect contracts and recovery automation.
6. Standalone `Upadek / Falling`.
7. Real `drop-held-items` application using canonical held state.
8. Fate internal `{value,max}` cleanup to final one-value contract with migration.
9. Future Psychika i zdrowie categories such as Diseases and Mutations only after real Item/data contracts are audited.
10. Remaining unaudited Actor/Item types and Classic-sheet sections required by the MVP.

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
- Keep user-facing equipment state simple, but retain mechanically necessary internal precision.

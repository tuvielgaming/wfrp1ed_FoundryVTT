# Session Handoff

**Date:** 2026-08-09  
**Purpose:** Current implementation/architecture checkpoint. Replace/update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact files before every code change.

## Latest checkpoint — STOPPED BEFORE RUNTIME TEST

The session ended immediately after adding a proper Foundry v14 WFRP ActiveEffect subtype to address reload/copy persistence.

Latest persistence commits:

- `8568ccf5c7254b9a6b4b344fbfffde85bdd0dc38` — add persisted WFRP Active Effect subtype;
- `e6a1febe1357556e1d7f7104da50059d30b5a4a3` — register WFRP Active Effect subtype in the system/manifest.

**These two persistence commits have NOT yet been runtime-tested.**

Because `system.json` changed, the next session must begin with:

```text
git pull
```

then a **full Foundry restart**, not only a browser hard refresh.

### Exact first test next session

Use a world Skill Item and test in this order:

1. Open a world Skill Item.
2. Reuse/create an Active Effect.
3. Add a new WFRP rule, e.g. `Ukrywanie się +10`.
4. Close and reopen the Skill — rule should still be visible.
5. Fully restart Foundry again.
6. Reopen the same world Skill — the rule must still exist after restart.
7. Drag that Skill onto an Actor which does not already own it.
8. Open the Actor-embedded Skill — its Active Effect and WFRP rule must be present.

Do not claim persistence is fixed until these steps pass.

## Persistence bug history / diagnosis

Observed before the latest subtype fix:

- WFRP Active Effect rule edits appeared correctly in the live Skill sheet.
- They could be edited/reopened during the same Foundry session.
- After Foundry reload/restart, rules reverted/disappeared.
- Dragging a world Skill to an Actor produced an embedded Skill without the authored WFRP rule data.

Earlier investigation established Foundry v14 stores Active Effect changes in `ActiveEffect.system.changes`, not legacy top-level `changes`.

The editor/resolver was migrated accordingly:

- Skill authoring writes `system.changes`;
- resolver reads `effect.system.changes`;
- creation/edit/delete use the parent Item embedded-document update path.

However, live-session-only persistence remained. The current hypothesis/fix is that WFRP-authored effects need a declared system-owned ActiveEffect subtype backed by Foundry v14 `ActiveEffectTypeDataModel` rather than relying on generic `type: "base"`.

Current implementation:

- `module/effects/WfrpActiveEffectSetup.mjs` defines `WFRP_ACTIVE_EFFECT_TYPE = "wfrp"`;
- `WfrpActiveEffectData extends foundry.data.ActiveEffectTypeDataModel` unchanged;
- it registers `CONFIG.ActiveEffect.dataModels.wfrp`;
- it sets `CONFIG.ActiveEffect.defaultType = "wfrp"`;
- older/base effects containing WFRP rule changes are migrated to type `wfrp` on the next relevant update;
- `system.json` declares the ActiveEffect subtype.

Again: this is **implemented but not yet runtime-validated**.

## Duplicate Skill bug — OPEN

The Actor currently allows the same Skill to be embedded multiple times.

User explicitly reported this is wrong for the normal Skill workflow.

Do **not** implement duplicate blocking until the persistence/copy test above is confirmed, so these two concerns stay isolated.

After persistence passes, audit the canonical Skill identity rule before blocking duplicates. Stable `system.rulesId` exists for mapped core Skill identity, but specialised/custom Skills may require identity rules that include specialisation and/or source UUID rather than display name alone.

## Active Effect authoring — live-tested working before restart

The Skill Item WFRP effect UI has been live-tested successfully for the following within a running Foundry session:

- add native Active Effect;
- persistent enable/disable toggle during the live session;
- add WFRP rule change;
- localized target dropdown;
- edit existing WFRP rule and reopen with saved values;
- multiple WFRP rule changes inside one Active Effect;
- operations/value/formula/side/applicability/stacking/condition persisted in the live Document;
- effect target IDs remain stable and language-neutral.

The rule editor presentation uses localized target labels. Internal mechanics use stable IDs.

## Active Effect architecture — approved

Active Effects are a **system-wide WFRP rule mechanism**, not Skill-only.

Skills are the first authoring surface, but the common resolver/editor must also support rule-bearing Items such as weapons, armour, equipment, spells, diseases, traits/talents, conditions, etc. Future dedicated Item types such as armour/disease should use the same infrastructure.

Subsystems must ask for effects targeting stable rule parameters rather than checking Item names or specific Skill identities.

Examples:

- `test.standard.hide.target`
- `test.characteristic.int.target`
- `procedure.movement.jump.reductionDie`
- `procedure.movement.leap.distance`
- future combat/damage/healing/magic parameters.

Owning an Item does not automatically mean every effect applies: future weapon/equipment/spell/disease state (equipped, worn, active, duration, stage, etc.) must participate in availability.

## Per-roll Active Effect selection — live-tested working

Relevant effects are shown directly in the Standard Test window.

User-approved compact presentation direction:

```text
☐ Cichy Chód w mieście: +10 (sytuacyjny)
```

Do not repeat the selected Standard Test name inside the effect label; the dialog already identifies the test.

Checkbox visuals were explicitly corrected and user approved them:

- unchecked = simple empty square;
- checked = plain check mark;
- no native Foundry black rectangle/stylized checkbox artwork.

Important behavior:

- persistent ActiveEffect enabled/disabled state is not changed by a roll checkbox;
- contextual/manual effects can be selected per roll;
- automatic effects are selected by default;
- non-GM users cannot suppress automatic effects;
- GM may override them for adjudication;
- only effects relevant to the selected test/procedure are shown.

## Post-roll Active Effect adjudication — live-tested working

GM can enable/disable Active Effect modifiers in the expanded test-result chat card after the roll.

The same original d100 remains fixed. Toggling a modifier only recalculates:

- total modifier;
- final target;
- margin;
- success/failure.

It does not:

- reroll;
- reread Actor/Skill/ActiveEffect data;
- mutate the underlying persistent ActiveEffect.

Unchecked roll-time candidates are intentionally snapshotted as disabled modifiers so the GM can enable them after the roll.

The general `Modyfikator testu` remains separately numeric-editable by the GM.

## Deferred-target Active Effect selection bug — FIXED AND LIVE-TESTED

Bug found and fixed:

For target-dependent Standard Tests such as `Ukrywanie się`, a checked contextual Active Effect was preserved only when the target was already selected before opening the test. If the test created a pending target card and the GM supplied the target later, the effect selection was lost/reset.

Cause: `PendingStandardTest._serializeOptions()` did not serialize `options.ruleEffects`.

Fix commit:

- `64c847e0039629df688306f827fdd53677aceda4` — preserve rule effect selections in pending tests.

Pending request version is now 2 and stores a mutable deep-enough copy of the per-roll rule-effect snapshot, including nested source metadata. This deliberately avoids the previous frozen-ChatMessage-flags crash.

User confirmed this fix works.

## Movement procedures / Skills

`Skok` and `Zeskok` were verified against both English and Polish WFRP 1e Core Rulebooks before implementation.

Verified sources:

- English Core Rulebook printed p.75 — Jumping/Falling/Leaping/Climbing;
- Polish Core Rulebook printed p.75 — Zeskok/Upadek/Skok/Wspinaczka;
- English/Polish Skill sections for Acrobatics/Akrobatyka and Clown/Błaznowanie.

Important architecture correction is complete:

`MovementStandardTest` no longer contains hardcoded Acrobatics/Clown Skill identity/bonus tables. Movement consumes the generic Active Effect parameters:

- `procedure.movement.jump.reductionDie`;
- `procedure.movement.leap.distance`.

This is the approved final direction: procedures consume generic effects and do not ask whether a specific Skill exists.

Movement runtime testing is still secondary to resolving ActiveEffect persistence first.

## Approved damage architecture — SAVE THIS

The user approved a WFRP4e-like chat workflow for applying calculated damage.

A roll/procedure calculates damage but must **not silently mutate Wounds at calculation time**.

Target architecture:

`damage-producing action/procedure`
→ `DamagePacket`
→ `DamageResolver`
→ `DamageApplication`
→ Actor Wounds / later critical handling.

`Apply Damage / Zastosuj obrażenia` from the ChatMessage context menu should be available to:

- GM; or
- user who owns the Actor receiving damage.

Permission is checked against the **damage target**, not necessarily the rolling Actor.

Generic `DamagePacket` must support at least:

- raw amount;
- target Actor UUID;
- source kind/id;
- Armour apply/ignore;
- Toughness apply/ignore;
- optional hit location;
- future special mitigation flags;
- application transaction state.

`Zeskok` is intended as the first consumer and explicitly ignores Armour and Toughness.

After application the ChatMessage should store amount applied, Wounds before/after, user, timestamp/state and prevent accidental double application.

Possible later GM-only Undo must use the stored transaction; do not blindly add Wounds back.

Do not implement Zeskok-specific Wounds subtraction outside this generic pipeline.

## Effect vocabulary approved

The common WFRP Active Effect system must ultimately support more than fixed Standard Test modifiers:

1. test target modifier;
2. self/target/opponent side;
3. formula-derived modifier;
4. contextual/manual applicability;
5. stacking/repeated-acquisition policy;
6. procedure parameter modifier;
7. characteristic/profile modification;
8. combat-rule modifier;
9. capability/permission effects;
10. outcome/rule transformations.

Use Foundry ActiveEffect Documents as persistent declarative rule records, with a WFRP resolver executing domain semantics at the relevant subsystem boundary.

## Important current commits from this session

Active Effect/editor/integration history includes:

- `32d330a` — fix DialogV2 wrapper;
- `44e647b`, `042f936` — localized effect targets;
- `bb2349f`, `3db47d1`, `108cf6c` — persistence diagnostics/attempts;
- `62ff6bc`, `104fc73` — migrate resolver/editor to v14 `system.changes`;
- `a9f4488` — hydrate rule editor from persisted change;
- `350e4f4`, `92d9fd0`, `4726c9a` — checkbox/row presentation refinements;
- `398d12a`, `033e422`, `7bcaf4c`, `c9ebe5c`, `1e4890f`, `af51ca4`, `1c0c5ba` — preserve candidates and add GM post-roll effect toggles;
- `64c847e` — preserve effect selections through deferred target resolution;
- `8568ccf`, `e6a1feb` — WFRP ActiveEffect subtype persistence fix, **not yet runtime-tested**.

## Next-session order

1. Pull latest `master` and fully restart Foundry.
2. Run the exact world Skill → restart → Actor copy persistence test above.
3. If persistence fails, inspect the WFRP ActiveEffect subtype/source data; do not move on by assumption.
4. If persistence passes, implement duplicate Skill prevention at the correct Actor/embedded-Item boundary.
5. Re-test dragging a world Skill with Active Effects onto an Actor.
6. Continue `Skok/Zeskok` Active Effect runtime testing.
7. Only after the effect foundation is stable, move to the approved generic DamagePacket/Apply Damage pipeline.

## Important cautions

- Foundry runtime validation is definitive; do not claim untested persistence is fixed.
- `system.json` changed at the latest checkpoint, so a full restart is required before the next test.
- Do not create another Skill-specific rules database; Active Effects are the mechanical rule source.
- Stable `system.rulesId` remains useful for core identity/migration/content mapping, not as a substitute for Active Effect mechanics.
- Do not mutate persistent ActiveEffect state for per-roll choices.
- Keep non-d100 movement procedures outside generic percentile `Test`.
- Verify WFRP mechanics against English Core and Polish terminology before implementation.
- Do not apply calculated damage directly; use the approved damage transaction pipeline.

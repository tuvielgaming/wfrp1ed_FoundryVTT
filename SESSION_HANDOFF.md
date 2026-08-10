# Session Handoff

**Date:** 2026-08-10  
**Purpose:** Current implementation/architecture checkpoint. Update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact file before every code change.

## Current confirmed checkpoint

Two major slices are now live-tested in Foundry v14:

1. Skill + Active Effect persistence/adjudication.
2. Generic damage packet + explicit ChatMessage application, including the full GM/player permission matrix.

The last code runtime-confirmed by the user is after commit:

```text
c0adce4569e39f463b1c9169ed78e8fc94ec66d4
Fix Foundry v14 context menu callback adapter
```

On 2026-08-10 the user additionally confirmed all remaining damage-permission scenarios:

- GM can apply damage;
- a non-GM player with OWNER permission on the target Actor can see and use `Zastosuj obrażenia` on a GM-authored damage message;
- the target Actor Wounds update correctly for that player-owner path;
- double-application protection still works;
- a non-owner player does not receive the apply action.

No source-code change was required for those permission confirmations.

---

# Skill + Active Effect subsystem — CONFIRMED

## Persistence

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

## Duplicate Skill prevention — CONFIRMED

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

## Per-roll Active Effect selection — CONFIRMED

Relevant effects are shown directly in the Standard Test dialog.

Approved compact presentation:

```text
☐ Cichy Chód w mieście: +10 (sytuacyjny)
```

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

---

# Startup regression history — IMPORTANT

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

A small ActiveEffect `wfrp` compatibility declaration still exists because some world documents may have been created during the earlier subtype experiment. Do not remove compatibility support casually while existing worlds may contain those documents. Do not reintroduce the old automatic type-migration hook.

---

# Active Effect architecture — APPROVED

Active Effects are a system-wide WFRP rule mechanism, not Skill-only.

Skills are the first authoring surface. The common effect infrastructure must later be usable by weapons, armour, equipment, spells, diseases, traits/talents, conditions, and other rule-bearing Items.

Subsystems consume stable rule parameters instead of checking Skill/Item names.

Current examples include:

- direct characteristic-test targets;
- named Standard Test targets;
- `procedure.movement.jump.reductionDie`;
- `procedure.movement.leap.distance`.

Persistent ActiveEffect enabled/disabled state is separate from per-roll choices.

---

# Movement / rulebook boundary

Movement procedures must not hardcode Skill names. They consume stable Active Effect parameters.

Do **not** invent or extend WFRP 1e `Skok` / `Zeskok` damage mechanics from memory.

Before wiring actual fall/jump damage formulas into the new damage pipeline, verify the relevant rules against both:

- English WFRP 1e Core Rulebook for mechanics;
- Polish Core Rulebook for terminology/translation differences.

The rulebook PDFs are not tracked in current GitHub `master`.

On 2026-08-10 a File Library search found the existing `RULEBOOK_IMPLEMENTATION.md` audit and project-state documents, but did not surface the English or Polish core-rulebook PDFs themselves. Therefore the next mechanics change is blocked until the user provides/accesses both rulebooks again, preferably by uploading the current repository ZIP containing both PDFs or the two PDFs directly.

---

# Generic damage subsystem — FULL PERMISSION MATRIX CONFIRMED

## Architecture

The implemented flow is:

```text
damage-producing action/procedure
→ DamagePacket
→ DamageResolver
→ DamageResolution
→ DamageApplication
→ Actor remaining Wounds
```

Damage calculation and damage application are deliberately separate. Calculating damage must not silently mutate an Actor.

## Implemented domain contracts

Current files:

```text
module/damage/DamagePacket.mjs
module/damage/DamageResolution.mjs
module/damage/DamageResolver.mjs
module/damage/DamageApplication.mjs
module/damage/DamageChat.mjs
module/damage/DamageBootstrap.mjs
```

`DamagePacket` stores a JSON-safe immutable snapshot including:

- packet id;
- raw amount;
- target Actor UUID;
- source kind/id/optional label/UUID;
- Armour policy (`apply` / `ignore`);
- Toughness policy (`apply` / `ignore`);
- optional hit location;
- future special-mitigation metadata.

`DamageResolution` stores the already-resolved final amount separately from Actor mutation.

`DamageResolver` is intentionally strict at this stage:

- packets with Armour=`ignore` and Toughness=`ignore` can resolve directly;
- packets requesting normal Armour/Toughness mitigation currently fail deliberately;
- do not implement generic mitigation math until the relevant English + Polish combat rules are audited.

The runtime API is exposed at:

```js
game.WFRP1ED.damage
```

with:

```text
Packet
Resolution
Resolver
Application
Chat
mitigationPolicy
```

## Damage application transaction — CONFIRMED

`DamageApplication` updates:

```text
system.status.wounds.value
```

and allows remaining Wounds to go negative for later critical-damage handling.

Authorization is now live-tested for the full intended matrix:

- GM may apply damage — CONFIRMED;
- target Actor OWNER may apply damage — CONFIRMED;
- target owner can apply damage from a GM-authored ChatMessage — CONFIRMED;
- a non-owner player does not receive the apply action — CONFIRMED.

Permission is checked against the target Actor, not the message speaker/rolling Actor.

Authoritative application state is stored on the target Actor under WFRP flags, keyed by DamagePacket id.

Stored transaction includes:

- transaction id;
- packet id;
- target Actor UUID;
- applied amount;
- Wounds before;
- Wounds after;
- applying user id;
- timestamp;
- `state: "applied"`.

The Actor transaction is authoritative because a target owner may be allowed to update their Actor even when they cannot modify the GM-authored ChatMessage.

## Double-application protection — CONFIRMED

User explicitly confirmed that a packet cannot be applied a second time, including when trying to call the application path again from the console.

The same packet id is rejected once the target Actor already contains its applied transaction.

## Standalone damage ChatMessage — CONFIRMED

A generic standalone damage card is implemented with:

- target;
- source;
- final damage amount;
- optional raw amount when different;
- Armour/Toughness policy display;
- optional hit location;
- application status.

Right-click action:

```text
Zastosuj obrażenia
```

is available only when the current user may apply the packet and the packet has not already been applied.

The user confirmed successful application as GM and as a non-GM OWNER of the target Actor.

After successful application, the standalone card shows a summary such as:

```text
Zastosowano 1 · Żywotność 6 → 5
```

and the same packet no longer offers the application action.

A player without OWNER permission on the target Actor does not receive `Zastosuj obrażenia`.

## Foundry v14 ContextMenu API fix — CONFIRMED

Foundry v14 deprecated the old ContextMenu entry fields:

```text
name
condition
callback
```

in favor of:

```text
label
visible
onClick
```

The important behavioral difference is callback signature:

```js
// legacy
callback(target)

// v14
onClick(event, target)
```

A first compatibility conversion only renamed the field and therefore passed the `PointerEvent` to the legacy callback as if it were the ChatMessage element. Result: selecting `Zastosuj obrażenia` silently did nothing.

Final fix wraps the old callback semantics correctly:

```js
entry.onClick = (_event, target) => legacyCallback(target);
```

Final confirmed fix commit:

- `c0adce4569e39f463b1c9169ed78e8fc94ec66d4` — Fix Foundry v14 context menu callback adapter.

This adapter also protects existing test-result context-menu actions which were authored with the older callback convention.

## Remaining Wounds / Classic sheet integration

The profile `Żyw` characteristic is the Wounds maximum/profile characteristic. In-play remaining Wounds are separate persistent state at:

```text
system.status.wounds.value
```

Before the damage workflow, that field was hidden and schema-defaulted to `0`, so old undamaged Actors could appear internally as zero Wounds.

Current integration:

- undamaged Characters whose in-play Wounds lifecycle has not begun synchronize the hidden remaining-Wounds value to their current Wounds maximum;
- first actual damage application sets `flags.wfrp1ed.woundsInitialized = true`;
- once initialized, remaining Wounds are no longer auto-synchronized to profile maximum;
- the Classic `Żyw` cell displays remaining/max (for example `6/6`, then `5/6`) instead of hiding the in-play state.

Relevant commits:

- `61d6572b29b9e08b30281bc39f5a4178c85df915` — initialize remaining Wounds before damage application;
- `894ad51b10c0dec3eb892bdf178b3282b60b4c03` — initialize legacy Wounds and normalize v14 chat menus;
- `305c0715b5fa7fce6d355c8199e7ad3eaef1dbd0` — show remaining Wounds in Classic profile;
- `c1852bc561c6a61b71c98fd381a134946b9deb32` — style remaining Wounds;
- `69a17c84f9585d08bdf5a32971b72566229d813a` — load Classic remaining-Wounds styles;
- `7c6dcd587ac9efd126f9d7cfd6069690bd03d58a` — keep undamaged Wounds synchronized with profile.

## Damage commits

Foundation:

- `1f6a339e3173fa003921b126dafce039c9e33485` — add DamagePacket;
- `33adf495666d2579e0ba8e70b550c715a1a82074` — add DamageResolution;
- `adf5909becfbe3cb27a8b01eb8c769c71f3ebb8d` — add strict DamageResolver;
- `cc4e9ddf0a73890d360e6e051d26a422e2037c4a` — add DamageApplication;
- `d6a4d58c64e4e551f2928ce4d088029f72fdad5f` — expose damage API;
- `5bf519a4585ec40762f80233fc479ef9e356a1d8` — load damage subsystem.

Chat/application:

- `12dff6278b80d54f70f51f4f924e6d1a2ae0e158` — persist application transactions on target Actors;
- `fc90d9a3bbcd44e129868ffcba0d270f68a4c85a` — generic damage ChatMessage controller;
- `a2f9c99bb66982aec30d8bf96e0a5df80cf21914` — standalone damage result card;
- `e3d6b9e04f85e156c72969ec290d3ea0e7cd1911` — damage-card styling;
- `e59af2d473ad465015f88eccf4a9902659dd6a9c` — register damage chat integration;
- `1a7a19e9f6ae5abaa5bd44f415974c6e55805ba2` — load damage chat styles;
- `4568228af2e8a9a8d357b4894e771718d7d13347` — hide apply hint after application;
- `c0adce4569e39f463b1c9169ed78e8fc94ec66d4` — correct Foundry v14 context-menu callback adapter; user confirmed working.

---

# NEXT SESSION / CURRENT NEXT TASK — start here

Do not redo the GM/player permission tests unless a regression appears. The complete intended permission matrix is now confirmed working.

Next steps in order:

1. **Obtain both WFRP 1e core rulebooks in the current working context.**
   - English WFRP 1e Core Rulebook: primary mechanics authority.
   - Polish WFRP 1e Core Rulebook: terminology and translation comparison.
   - Current File Library search did not surface the PDFs themselves.

2. **Verify `Skok` / `Zeskok` rules in both books before any mechanics change.**
   - exact procedure;
   - exact damage formula;
   - whether Armour applies or is ignored;
   - whether Toughness applies or is ignored;
   - any reduction/avoidance roll;
   - exact English and official Polish terminology;
   - document printed page/chapter references in `RULEBOOK_IMPLEMENTATION.md`.

3. **Inspect the current movement producer code from GitHub only after rulebook verification.**

4. **Wire verified `Zeskok` damage into the generic DamagePacket → DamageResolver → DamageChat pipeline as the first real producer.**
   - calculation must create/publish damage;
   - it must not directly subtract Wounds;
   - application remains the confirmed explicit `Zastosuj obrażenia` transaction.

5. Keep generic Armour/Toughness `apply` calculation disabled until normal combat damage/mitigation rules are separately audited against both rulebooks.

6. Later extend the same generic damage pipeline to normal weapon/combat damage, spells, hazards, etc.

Possible later enhancement:

- GM-only Undo Damage based on the stored transaction, but it must validate current Actor state before reversing anything; never blindly add the old amount back.

---

# Important cautions

- Foundry runtime validation is definitive.
- If `system.json` changes, perform a full Foundry restart.
- Read back startup/import-critical files after replacement.
- Do not claim WFRP mechanics are complete until English mechanics and Polish terminology are verified.
- Do not apply damage at roll calculation time; use the explicit DamageApplication transaction pipeline.
- Do not calculate or mutate persistent ActiveEffect state for per-roll choices.
- Do not auto-delete historical duplicate Skills.
- Avoid touching the now-confirmed Active Effect persistence path unless a concrete defect requires it.
- Preserve the current ActiveEffect compatibility subtype declaration until old world data has been safely audited/migrated.

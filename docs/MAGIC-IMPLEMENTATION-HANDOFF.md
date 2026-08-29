# Magic Implementation Handoff

**Status:** Canonical magic continuation checkpoint  
**Date:** 2026-08-29  
**Repository:** `tuvielgaming/wfrp1ed_FoundryVTT`  
**Branch:** `master`

This document is the durable restart point for future WFRP 1e magic work. It is intentionally subsystem-specific and does not replace `PROJECT_STATE.md`, `RULEBOOK_IMPLEMENTATION.md`, `FOUNDRY_V14_GUIDELINES.md`, or the general `SESSION_HANDOFF.md`.

When a future session is asked to "go back to magic", "continue magic", or similar, read this file first, then inspect current `master` before changing code. Do not reconstruct the current magic implementation from conversation memory.

---

## Current magic baseline

### Fire Ball

**Status: IMPLEMENTED + RUNTIME VERIFIED / COMPLETE as of 2026-08-29.**

Do not redesign or refactor Fire Ball merely because its implementation is large. Leave it unchanged unless a later integration exposes a concrete regression or an approved architecture refactor explicitly includes it.

The verified Fire Ball rules/behavior are:

- One casting may create multiple physical Fire Balls.
- Each physical Ball independently determines how many targets it hits.
- Target-count is `Power Level × d3` for each physical Ball.
- Dice So Nice has no native d3 presentation, so the system visually bridges the logical d3 through d6 animation while preserving logical d3 results.
- Each Ball has its own grouped/aggregate chat presentation.
- **Main Fire Ball damage is resolved independently for every target hit by every Ball. It is not one shared damage roll per Ball.**
- The Fire Ball `d10` damage roll is therefore per Ball-target impact.
- Flammable extra `d8` damage is also per Ball-target impact.
- Initiative damage reduction is resolved independently per Ball-target impact.
- Fear of Fire is a cast/target-level effect: once per creature per casting, not once per Ball and not once per impact.
- Each impact retains its own damage application transaction, rollback/invalidation lifecycle, and reroll lifecycle.
- Reverting/invalidation of one target's Fire Ball damage preserves that target's resolved Initiative result, returns only its Damage state to pending, reopens the grouped Ball card as unresolved, preserves the old reverted Damage card as audit history, and permits a fresh reroll/new DamagePacket.
- Group cards auto-collapse when fully resolved and reopen if adjudication makes them unresolved again.
- Damage uses the existing generic damage pipeline rather than a parallel spell-only wound system.
- Fire Ball critical behavior uses the approved magic-specific/fallback critical policy already present in current source.
- Casting failure, Magic Point expenditure, permissions/ownership, chat synchronization, Dice So Nice reveal ordering, editable roll values, and grouped presentation were all exercised during the implementation cycle.

The final invalidation/re-arm sequence was runtime verified by the user on 2026-08-29:

```text
Initiative
→ Roll Damage
→ Apply / adjudicate damage
→ Revert / Invalidate damage
→ Initiative stays resolved
→ Damage returns to Pending
→ grouped Ball becomes unresolved and reopens
→ old Damage card remains COFNIĘTO / reverted history
→ Roll Damage again
→ fresh dice result + fresh DamagePacket/new Damage card
```

### Important warning: do not "simplify" Fire Ball into shared per-Ball damage

A previous discussion briefly proposed one shared damage roll for all targets of a Ball. That proposal was explicitly rejected as incorrect.

The canonical project decision is:

```text
CAST
│
├── cast/target-level effects
│      └── Fear of Fire: once per creature per cast
│
└── PHYSICAL BALL
       │
       ├── target-count roll for that Ball
       │
       └── BALL-TARGET IMPACT
              ├── Initiative test/result
              ├── independent Fire Ball d10 damage roll
              ├── independent Flammable d8 when applicable
              ├── target-specific Toughness/result calculation
              └── independent DamageApplication transaction
```

Preserve this distinction.

---

## Why Fire Ball became so large

Fire Ball is genuinely one of the more complicated spells because the rules and the VTT lifecycle combine several independent concerns:

- one cast producing multiple physical projectiles;
- one target-count roll per projectile;
- overlapping target sets;
- per-impact Initiative adjudication;
- per-impact damage;
- optional per-impact Flammable damage;
- cast/target-level Fear deduplication;
- Magic Point/resource expenditure and casting failure;
- multiplayer ownership/GM authority;
- persisted ChatMessages and editable historical results;
- Dice So Nice animation before result reveal;
- generic damage application, criticals, rollback and audit history;
- grouped chat presentation that must remain synchronized with canonical impact state.

Those behaviors are mostly legitimate. The concern is not that Fire Ball was "automated too much". The concern is that the first complex spell forced several reusable VTT/magic behaviors to be implemented in Fire-Ball-specific modules.

Examples of reusable concepts that should not have to be reinvented for every future spell:

```text
roll a characteristic test for a target
roll spell damage
apply damage through the canonical Damage pipeline
invalidate/re-arm unapplied or reverted spell damage
show a group of related resolutions
keep source and derived result cards synchronized
run an effect once per cast-target
run an effect once per projectile-target impact
show physical dice before revealing result UI
delegate rolls according to Actor ownership / GM authority
apply a spell-specific critical policy
```

The presence of several `FireBall...` integration modules is therefore useful evidence for future architecture extraction, but it is not a reason to rewrite the working spell now.

---

## Architectural direction for future magic

### Principle

Future spells should increasingly describe **what they do** while shared infrastructure handles **how Foundry performs and persists it**.

Conceptual target:

```text
Spell
  ↓
MagicCast
  ↓
Cast Procedure
  ↓
Reusable Effects / Resolution Steps
      ├─ Targeting
      ├─ Characteristic Test
      ├─ Damage
      ├─ Condition / Active Effect
      ├─ Psychology
      ├─ Resource change
      ├─ Duration / expiration
      └─ spell-specific procedure when genuinely unique
  ↓
Existing generic Test / Damage / Chat / Actor / permission infrastructure
```

This is an architectural direction, not an instruction to immediately build a giant universal spell engine.

### Avoid the opposite mistake: premature UniversalSpellEngine

Do **not** generalize the whole magic subsystem from Fire Ball alone. One complex spell is not enough evidence for the final abstraction.

Before implementing another large batch of spells, audit roughly **8–12 representative WFRP 1e Core spells** and classify them by recurring mechanical pattern. Likely families include:

```text
simple instantaneous effect
direct damage
damage + resistance/characteristic test
buff/debuff
duration effect
area effect
multiple projectiles
summoning
movement/teleport
persistent environmental effect
special procedure
```

Only after repeated patterns are confirmed should shared primitives/services be extracted.

### Desired reuse boundary

A future ordinary spell such as "target makes characteristic test; on failure apply condition X for N rounds" must not need a new family of 10–15 spell-specific integration modules.

Likewise, a simple damaging spell should be able to compose generic capabilities conceptually equivalent to:

```text
Target selection
→ optional resistance Test
→ generic spell Damage request
→ canonical DamageApplication
→ optional duration/effect
→ standard chat/audit presentation
```

The exact JavaScript API is deliberately **not specified yet**. It must be designed after the representative-spell audit rather than invented from this document.

---

## WFRP4e Foundry comparison: lesson, not specification

During the architecture discussion, the maintained WFRP4e Foundry implementation was inspected for architectural comparison.

The useful lesson is that mature systems can make individual spell scripts look small because substantial generic infrastructure already exists underneath for tests, targeting, effects, chat, permissions and actor updates. That does **not** mean the complete spell implementation is intrinsically tiny.

For this WFRP1e project:

- WFRP4e code may be studied for software-architecture ideas.
- WFRP4e rules must never become a mechanics source for WFRP1e.
- Core WFRP1e mechanics still require verification against the English Core Rulebook, with the Polish Core Rulebook used for terminology and translation comparison according to project policy.

---

## Current Fire Ball module map

These modules existed as part of the completed Fire Ball implementation at the time of this checkpoint. Always verify current `master` before relying on this list because later refactors may move responsibilities.

```text
module/magic/FireBallProcedureV2.mjs
module/magic/CoreCastingFailureWorkflow.mjs
module/magic/SpellCastLinkage.mjs
module/magic/FireBallExplicitCastContext.mjs
module/magic/FireBallImpactWorkflow.mjs
module/magic/FireBallBallGroupPresentation.mjs
module/magic/FireBallBallGroupAutoCreate.mjs
module/magic/FireBallBallGroupInitiativeAction.mjs
module/magic/FireBallBallGroupActionRecovery.mjs
module/magic/FireBallBallGroupDiceRevealGuard.mjs
module/magic/FireBallBallGroupDisclosureIndicator.mjs
module/magic/FireBallCastPsychologyPresentation.mjs
module/magic/FireBallVulnerabilitySync.mjs
module/magic/FireBallDamageResultView.mjs
module/magic/FireBallDamageCardConsistency.mjs
module/magic/FireBallCriticalFallback.mjs
module/magic/FireBallPsychologyResultPresentation.mjs
module/magic/FireBallDamageInvalidationLifecycle.mjs
module/magic/SpellBootstrap.mjs
```

Related generic infrastructure includes, among other files:

```text
module/tests/ActorTestRequestWorkflow.mjs
module/chat/DiceFirstChatReveal.mjs
module/chat/ChatBottomFollow.mjs
module/damage/DamageApplication.mjs
module/damage/DamageChat.mjs
```

Do not infer responsibility only from filenames; inspect current source before modifying.

---

## Key completed Fire Ball implementation commits

These commits are historical anchors only. Current `master` is always authoritative.

```text
749202f9f12255130e5dd3f4e2f05d0c64e5c86a  grouped disclosure behavior, runtime verified
e800514486e5145c9973013a9184a2a8e9fe5623  explicit Fire Ball cast context
d65f15c44f6c175ec5d559e3d8e251f9f373a28f  grouped Initiative action fix
17d221c38f20b254ab9bd98ee7262c695af783a6  post-update grouped Initiative redecorating
4636ab6f9ab908c5649151e8e8ece034d256dac6  grouped action recovery
3e88380ca2bfa1702289522b62122a95a4d54c26  Fire Ball damage card consistency
06b304740c8ea25c13ccecf4056aa13f187c340e  chat bottom-follow behavior
decc4e9b49a21bbc55ae38118402fbd8c07f4cbc  initial Fire Ball damage invalidation lifecycle
5dfa1caf2a36bc0817ec14c85e81cf4521b07cd8  invalidation lifecycle synchronization/fix
887417580a25c3d7bd782facba1d3de4bdf5f6ec  bootstrap registration for invalidation lifecycle
```

Other earlier Fire Ball commits exist; use Git history/current source when deeper archaeology is required.

---

## Exact restart procedure for future magic work

When returning to magic in another chat/session:

1. Read this file first.
2. Fetch current `master`; do not assume the module list or commits above are still the latest code.
3. Treat Fire Ball as **complete and runtime verified** unless a concrete regression is being investigated.
4. Do not reopen the shared-vs-per-target damage question: damage is per Ball-target impact.
5. Before designing a reusable magic architecture, inspect the current generic Test, Damage, Chat, Actor ownership/authority and Active Effect/duration infrastructure so new magic primitives reuse existing owners rather than duplicate them.
6. Select approximately 8–12 representative **Core WFRP1e** spells spanning different mechanical families.
7. Verify each selected spell against the English Core Rulebook and corresponding Polish text before using it as architectural evidence.
8. Produce a pattern matrix showing which mechanics repeat across the selected spells.
9. From that evidence, propose the smallest reusable magic primitives/services needed by multiple spells.
10. Only after that review, decide whether any Fire Ball-specific code should be extracted into generic infrastructure. Do not refactor working Fire Ball code pre-emptively.
11. Implement future spells incrementally using those primitives, with source-first inspection and user runtime verification after each dependency-ordered batch.

### The next magic task is therefore

**Do not implement another complex spell immediately. First perform the representative Core-spell audit and design the reusable magic orchestration/effect layer from repeated patterns.**

That is the exact point from which future magic work should resume.

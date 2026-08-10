# Session Handoff

**Date:** 2026-08-10  
**Purpose:** Current implementation/architecture checkpoint. Update this file instead of creating overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the implementation source of truth. Fetch the latest exact file before every code change.

---

# Current session checkpoint

The session ended immediately after correcting the first Fate-sheet and Luck/Szczęście runtime defects reported by the user.

The last code commit before this handoff update is:

```text
af6a6b9bdf62dd29e1ce6dc2475a74d84bf6af02
```

That code is on `master`.

The user has **not yet runtime-tested this corrected build**. The next session must begin with a clean Foundry restart and verification of the Fate + Luck fixes described below.

Do not assume the corrected Fate/Luck behavior is confirmed until the user tests it.

---

# Runtime-confirmed foundations

The following areas were already live-tested and confirmed in Foundry v14 before the current Fate/Luck work:

1. Skill + Active Effect persistence/adjudication.
2. Duplicate Skill prevention.
3. Generic damage packet + explicit ChatMessage damage application.
4. Damage permission matrix: GM, target OWNER, non-owner denial.
5. Double-application protection.
6. Classic-sheet remaining/max Wounds display.
7. Wounds floor at zero during damage application.
8. Manual current-Wounds editing and its dedicated permission lock.
9. Bilingual WFRP 1e movement audit for Zeskok / Upadek / Skok.
10. Zeskok integrated into generic damage and runtime-confirmed.
11. Sudden Death critical resolution from an explicit ChatMessage action.
12. Sudden Death result publication as a separate roll-bearing chat card.
13. Critical-resolution permissions: GM OR user who created/caused the damage message.
14. Fatal Sudden Death result produces the expected `Śmierć / Killed` outcome.

The user explicitly confirmed the explicit Sudden Death critical flow worked before Fate/Luck work began.

---

# Wounds rule — confirmed

The English and Polish WFRP 1e Core Rulebooks were checked directly.

Canonical damage application remains:

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

Rules conclusions:

- remaining Wounds/Żywotność stop at `0`;
- Wounds never become negative;
- excess damage from one hit becomes that hit's `criticalValue`;
- later damage at zero Wounds creates a new per-hit critical value rather than accumulating negative Wounds.

Do not reintroduce negative Wounds as critical-state storage.

---

# Sudden Death critical flow — runtime-confirmed before current session end

Relevant historical commit:

```text
6a9a107b33a2eeeaed1d7ff4d60a8cc64a7982cd
Resolve criticals from dedicated chat action
```

Current intended flow:

```text
damage applied
→ pending Sudden Death state on damage card
→ explicit "Rozstrzygnij trafienie krytyczne"
→ real 1d100 roll by clicking user
→ Actor-authoritative critical resolution persisted
→ separate critical result ChatMessage
```

Display convention:

```text
Nagła Śmierć +6
```

Raw overflow values above 6 are normalized to the printed `+6` tier for presentation. Do not show a second `Tabela +6+` or raw overflow metadata.

Permissions:

- damage application: GM OR target Actor OWNER;
- critical resolution: GM OR source/damage-message creator;
- those are deliberately separate permissions.

---

# Fatal critical + Fate intervention — implemented, partially tested

Initial fatal/Fate implementation landed before the current Fate-sheet UI fixes.

Relevant earlier code head:

```text
a85bd23bcb1aaecf14c91908d17853c1e9a30689
```

Main file:

```text
module/criticals/FatalCriticalIntegration.mjs
```

Behavior:

```text
fatal Sudden Death result
→ Actor receives Foundry defeated/dead status overlay
→ eligible GM/OWNER may spend one Fate Point
→ original fatal critical result remains historically "killed"
→ separate Fate intervention flag records that death was averted
→ Fate decreases by exactly 1
→ defeated/dead status is removed
```

The fatal-critical implementation does **not** heal Wounds. A character may remain at 0 Wounds after spending Fate. This is intentional until a separate recovery/injury rule requires otherwise.

Permissions:

- attacker/source user may resolve the critical if authorized by the critical flow;
- only GM OR target Actor OWNER may spend the victim's Fate;
- unrelated users do not see the target's Fate count/action.

The user previously observed a fatal critical card showing that Fate had been spent and death averted, so the existing intervention path itself had already executed in runtime. The missing/incorrect part was the editable Fate resource on the Character sheet.

---

# IMPORTANT RULE CORRECTION — Fate Points are one resource

The user correctly identified that WFRP 1e does **not** use a separate current/max Fate Points concept on the character sheet.

The Classic sheet must expose exactly one value:

```text
PUNKTY PRZEZNACZENIA
[ value ]
```

No visible `Current` / `Maximum` distinction belongs in the WFRP 1e UI.

## Transitional internal storage caveat

`CharacterData` still currently stores Fate as:

```text
system.status.fate.value
system.status.fate.max
```

and still has joint validation which rejects:

```text
value > max
```

This is a **legacy/transitional internal model**, not the intended WFRP 1e rule/UI contract.

To avoid a risky Actor migration at the end of this session, the new sheet integration writes both values atomically to the same number:

```text
system.status.fate.value = N
system.status.fate.max   = N
```

This keeps existing Actors valid while presenting only the authentic single Fate resource.

Future cleanup should migrate CharacterData to a true single Fate value, but only as a dedicated migration slice after runtime confirmation of the current fix.

---

# Fate sheet correction — current untested build

Current files:

```text
templates/actors/classic/parts/fate.hbs
css/sheets/classic-status.css
module/fate/FateSheetIntegration.mjs
```

`system.json` now loads:

```text
module/fate/FateSheetIntegration.mjs
```

The corrected Classic page-2 Fate overlay:

- shows one numeric field only;
- has no added parchment/background fill;
- has no decorative underline;
- is centered inside the printed `PUNKTY PRZEZNACZENIA` box;
- is GM-editable and player read-only for direct manual editing;
- synchronizes transitional `value/max` internally in one Actor update.

The prior broken build produced:

```text
DataModelValidationError:
Current Fate Points cannot exceed maximum Fate Points.
```

when editing the visible Fate value. The current integration is specifically intended to eliminate that failure.

## First Fate test next session

After a full Foundry restart:

1. Open a Character Classic sheet, page 2.
2. Verify exactly one numeric Fate field is visible and aligned within the printed box.
3. As GM change it directly, e.g. `1 → 2`.
4. Confirm no DataModelValidationError occurs.
5. Cause a fatal Sudden Death critical.
6. Verify defeated/dead overlay is applied.
7. Spend one Fate Point.
8. Verify Fate decreases by one and defeated/dead status disappears.
9. Verify Wounds remain unchanged (normally 0).

---

# Luck / Szczęście rule audit — confirmed from Core Rulebooks

Official terminology:

```text
English: Luck
Polish:  Szczęście
stable rulesId: luck
```

Do **not** call this resource `Fortune` and do not resurrect the obsolete generic `status.fortune` field.

The mechanic belongs to the Skill `Luck / Szczęście`, not to a universal Fortune-point resource.

Verified core behavior:

- daily allowance is `1d6` uses;
- allowance is secret from the player;
- player learns it is exhausted only when a later attempted use fails;
- `d100/K100` may be changed by `±10`;
- `d6/K6` may be changed by `±1`;
- the skill may be used after seeing the original roll.

English-vs-Polish timing difference:

- English rule: secret `1d6` is rolled on the first attempted use during that game day;
- Polish rule: GM rolls the secret `K6` at the beginning of the day.

Project policy remains:

- English Core Rulebook controls mechanics;
- Polish Core Rulebook controls Polish terminology;
- significant edition/translation differences are documented, not silently merged.

Current default workflow therefore uses first-attempt initialization, while the GM also receives a manual `roll allowance now` action to support the Polish start-of-day timing.

---

# Luck Skill identity — corrected

Current stable identity remains:

```text
system.rulesId = "luck"
```

The Skill Item Rules Link must display **one localized name only**:

```text
Polish UI: Szczęście
English UI: Luck
```

It must **not** display:

```text
Luck / Szczęście
```

Current file:

```text
module/tests/standard-test-skill-identities.mjs
```

The identity stays language-neutral mechanically; only its presentation label changes with locale.

---

# Luck/Szczęście integration — current untested build

The first implementation in:

```text
module/luck/LuckBootstrap.mjs
```

was replaced after runtime defects were reported.

The old file is removed from the manifest and repository.

Current integration:

```text
module/luck/LuckIntegration.mjs
```

`system.json` loads it directly.

## Why the first runtime test failed

The user created/edited `Szczęście` on an Ork token Actor and correctly set its Rules Link to Luck/Szczęście, then made a Ballistic Skill roll.

Right-click showed no Luck action.

The key defect was Actor resolution: the first implementation preferred the world Actor prototype before the Scene Token Actor. For an unlinked/synthetic token, the token Actor may own a different embedded Skill set than its world prototype.

The corrected resolver now uses:

```text
ChatMessage speaker
→ Scene
→ Token
→ token.actor first
→ world Actor only as fallback
```

That is required for token-specific Skills and synthetic Actors.

## Foundry v14 context-menu contract

The corrected implementation uses the v14-style entry contract already proven by the damage/critical subsystems:

```text
label
visible
onClick(event, target)
```

Do not revert Luck context options to legacy `name / condition / callback` fields.

## Player actions on completed d100 TestResult cards

For an eligible Actor owning `rulesId = "luck"`:

```text
Szczęście: zmień wynik o -10
Szczęście: zmień wynik o +10
```

Eligibility:

- message must contain a WFRP `testResultState`;
- Actor must own a Skill Item with `system.rulesId === "luck"`;
- current user must be GM or Actor OWNER;
- one Luck modification maximum per test message;
- Luck cannot modify a roll after associated damage has already been applied;
- a non-GM needs an active GM because the allowance is secret and GM-authoritative.

## Hidden daily state

Current Actor flag:

```text
flags.wfrp1ed.luckDaily
```

State contains a generation/day counter, hidden allowance, used count and audit timestamps/user ids.

The allowance is persisted by the GM client only.

Player socket responses must never contain the hidden allowance or remaining uses.

## First use

Normal English-rule path:

```text
player chooses Luck ±10
→ request sent to primary active GM
→ GM receives confirmation prompt if today's pool is uninitialized
→ GM rolls hidden 1d6
→ GM-only whispered roll message is created
→ first Luck use is consumed
→ test card is re-evaluated from adjusted roll
```

Example:

```text
Target 20
original Roll 24
Szczęście -10
adjusted Roll 14
→ failure becomes success
```

The card should show an audit line similar to:

```text
Szczęście    24 → 14 (-10)
```

## Exhaustion

If hidden allowance was 3:

- first 3 attempts succeed and consume uses;
- the 4th attempt does not modify the roll;
- player receives:

```text
Szczęście cię opuściło.
```

The player still never sees the hidden original allowance.

## GM context actions

For a test belonging to an Actor with Luck:

```text
Szczęście: pokaż dzisiejszy stan
Szczęście: wylosuj dzisiejszy limit
Szczęście: nowy dzień / reset
```

`pokaż stan` is GM-only and may reveal used/allowance/remaining.

`nowy dzień / reset` clears the previous pool and leaves it uninitialized.

`wylosuj dzisiejszy limit` lets the GM initialize immediately, supporting tables which follow the Polish start-of-day wording.

---

# Luck scope boundary — K6 ±1 not implemented yet

The current Luck implementation only changes completed WFRP d100 TestResult cards by ±10.

The Core rule also permits d6/K6 changes by ±1, but that is **not yet wired to Zeskok/Skok movement cards**.

Do not implement this by merely changing displayed dice.

Movement procedures derive downstream values from their d6 results:

- Zeskok may change Wounds and a DamagePacket;
- Skok changes achieved distance and success/failure.

Therefore K6 Luck needs an immutable/re-runnable movement-result state so the procedure can safely recompute all consequences before any damage is applied.

Recommended later slice:

```text
movement roll snapshot
→ Luck ±1
→ recompute complete movement procedure result
→ update attached damage snapshot if still unapplied
```

Do not allow Luck to rewrite a movement die after its resulting damage has already been applied.

---

# Current manifest/runtime caution

`system.json` changed during Fate/Luck work and currently loads:

```text
module/effects/WfrpActiveEffectCompatibility.mjs
module/wfrp1ed.mjs
module/damage/DamageBootstrap.mjs
module/criticals/CriticalBootstrap.mjs
module/fate/FateSheetIntegration.mjs
module/luck/LuckIntegration.mjs
module/tests/TestResultModifierToggle.mjs
```

Because startup modules changed, a full Foundry/world restart is required before evaluating the current build.

A simple F5/hot refresh is not sufficient proof of clean startup.

---

# CURRENT NEXT TASK — start here

The corrected build at code commit:

```text
af6a6b9bdf62dd29e1ce6dc2475a74d84bf6af02
```

has not yet been runtime-tested.

Start the next session with this exact sequence:

1. Pull/update to current `master` and fully restart Foundry.
2. Confirm Character and Skill sheets open without startup/import errors.
3. Open Character page 2 and verify the Fate box has exactly one clean numeric field.
4. As GM edit Fate directly (`1 → 2`) and confirm no `DataModelValidationError`.
5. Open the `Szczęście` Skill and verify Rules Link shows only `Szczęście` in Polish (or only `Luck` in English).
6. Make a simple d100 characteristic test from an Actor/token which owns that Skill, e.g. Ballistic Skill.
7. Right-click the test result and verify `Szczęście: zmień wynik o -10/+10` appears.
8. Use `-10` on a near miss such as Target 20 / Roll 24.
9. Confirm GM receives the hidden daily-roll prompt.
10. Confirm GM sees the secret 1d6 result and the player does not see the allowance/remaining count.
11. Confirm the chat result changes from 24 to 14 and success/margin are recomputed without rerolling.
12. Test repeated uses until exhaustion and verify `Szczęście cię opuściło.` on the first over-limit attempt.
13. Verify GM status/reset/manual-roll actions.
14. Re-test fatal Sudden Death + spend Fate with the corrected one-value sheet.

If any Luck menu action is still absent, inspect in this order:

```text
message.getFlag("wfrp1ed", "testResultState")
message.speaker
resolved token.actor
actor.items with system.rulesId === "luck"
current user OWNER permission
active GM availability
```

Do not jump to K6 Luck or detailed Critical Wounds until this corrected d100/Fate path is runtime-confirmed.

---

# Likely next feature after confirmation

Once Fate + d100 Luck are confirmed, choose one contained next slice:

1. K6/K6 Luck ±1 with safe movement-procedure re-resolution; or
2. detailed/normal Critical Wound Item + Active Effects architecture.

The previously discussed detailed Critical Wound target remains:

```text
resolved detailed critical
→ real Item representing the wound/effect
→ Active Effects for mechanical consequences
→ draggable/assignable to Actor/token
```

Do not mix that detailed critical path with Sudden Death.

---

# Persistent project cautions

- Foundry runtime validation is definitive.
- No WFRP mechanic is implemented from memory alone.
- English Core Rulebook controls mechanics; Polish Core Rulebook controls terminology and is checked for differences.
- Original Polish character sheet controls Classic-sheet visual placement.
- Do not apply damage at roll-calculation time.
- Do not use negative Wounds as critical-state storage.
- Do not mutate persistent ActiveEffect state for per-roll choices.
- Do not auto-delete historical duplicate Skills.
- Do not infer rule identity from localized Item names; use stable `rulesId`.
- Resolve synthetic/token Actors before world prototypes when a ChatMessage speaker identifies a token.
- Keep damage permissions, critical-resolution permissions and victim-Fate permissions separate.
- Preserve the original physical roll when post-roll mechanics such as Luck alter the effective result.
- Avoid irreversible downstream consequences before post-roll interventions are finished.
- If `system.json` changes, perform a full Foundry restart.
- Fetch the current GitHub file before editing; never assume an old local copy is current.

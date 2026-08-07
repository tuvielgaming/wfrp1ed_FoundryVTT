# Session Handoff

**Date:** 2026-08-07  
**Purpose:** Temporary handoff for the next working session. Replace/update this file at the end of future sessions rather than creating additional overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub is the current implementation source of truth. Before modifying anything, fetch the latest `master` version of the exact file and its dependencies.

## Rulebook policy reminder

Official rulebooks are **not stored in Git**. For any new WFRP mechanics audit or implementation, the English and Polish WFRP 1e Core Rulebooks must be available separately in the working context. Do not infer mechanics from current code, memory, later editions, or fan summaries.

Authority order:

1. English WFRP 1e Core Rulebook — mechanics.
2. Polish WFRP 1e Core Rulebook — official Polish terminology and translation comparison.
3. Original Polish character-sheet scan — Classic-sheet visual authority.

## Session results

### Classic layout fixes

Live Foundry testing confirmed the recent Classic-sheet layout calibration is substantially improved.

Completed and tested:

- Characteristics use calibrated explicit column widths instead of equal-width columns.
- The obsolete page-2 Movement overlay was removed until that section is rebuilt properly.
- `Opis` textarea was recalibrated to show complete lines cleanly.
- Final user-tested `Opis` top position is `top: 90px`.

Relevant commits from this pass include:

- `9d09cab7aa718fe7cd9f117fef2193f32f4eb777` — calibrate characteristics and description.
- `95aabed4b71dcb5b49b84db1c66af479fea68d88` — remove obsolete Classic movement overlay.
- `7b81d3cb04adb44cb53af80e0d321b9f5a2397ca` — four full visible description lines.
- `15aa8f66e360a9edbe153d4576b9f23a10ffe33f` — final description position (`top: 90px`).

### Verified WFRP 1e combat finding to preserve

Do **not** implement successful d100 doubles (`11`, `22`, `33`, etc.) as a generic critical success.

Verified core behavior to preserve for later combat implementation:

- Normal attack succeeds when the attack roll is at or below the correct attack characteristic.
- Additional Damage is triggered by an unmodified `6` on the damage d6.
- That natural damage `6` requires the rulebook-defined confirmation roll, after which an additional d6 is added; further natural `6`s continue additional damage without repeated confirmation.
- Critical Hit in 1e is tied to damage exceeding the target's remaining Wounds buffer and then using the critical rules/table.
- Doubles have specific uses such as gunpowder/bomb misfires; they are not a universal critical-success mechanic.
- When ranged Additional Damage is implemented, re-check the exact English/Polish confirmation wording rather than assuming WS/BS substitution.
- Generic `TestResult` must not gain a doubles-based `criticalSuccess` flag.

### Standard Tests design decision

User wants a dedicated Standard Tests launcher on the Classic sheet.

Final UI decision:

- Place it at the top of the **first `UMIEJĘTNOŚCI` column**.
- Label:
  - Polish: `🎲 TEST STANDARDOWY`
  - English: `🎲 STANDARD TEST`
- Generic dice symbol is intentionally used instead of a d20 icon because WFRP does not use d20s.
- Direct clicking of a characteristic remains a direct characteristic test.
- The Standard Tests launcher opens a dedicated Standard Test selector/configuration flow.

Expected flow:

`🎲 TEST STANDARDOWY` → choose named Standard Test → system selects rulebook characteristic/formula → gather required contextual inputs → show potentially relevant owned skills → GM/player chooses which actually apply → apply verified modifiers → situational modifier → roll visibility → roll.

The rulebook explicitly leaves applicability of listed skills to the GM, so the system must **not automatically enable every matching Skill modifier**.

### Named Standard Tests audit

English Core Standard Tests and corresponding Polish section were audited. The current implementation distinguishes simple characteristic/formula tests from procedures that require dedicated handling.

Important examples already represented in the named registry:

- Fear / Strach → Cool / Op.
- Bargain / Targowanie się → Fellowship / Ogd.
- Disease / Choroba → Toughness × 10 / Wt × 10.
- Bribe / Przekupstwo → `100 - target.wp`.
- Hide / Ukrywanie się → `i + cl - target.i`.
- Pick Lock / Otwieranie zamków → `dex - lockDifficulty`.
- Listen / Słuchanie → contextual fixed chance via noise level.
- Risk / Ryzyko → fixed 50% base.
- Rapid Search / Szybkie przeszukiwanie → Search with the audited `-10` modifier.

Procedures such as Gambling, Employment, Busking, Movement-related tests, and Sneaking are intentionally not forced into the generic executable contract until their dedicated procedures are audited/implemented.

### Stable Skill rules identity

`SkillData` now has a persistent, language-neutral `system.rulesId` for audited core Skill mechanics.

This prevents mechanics from depending on editable/localized `Item.name`.

Key implementation commits:

- `50cb89aeac574f83dba8ed3dad317ea4dd4f4715` — add stable `rulesId` to Skill data.
- `4e0dd7b7083153e826e5bdaafcd22ef38eaa2d59` — initial Standard Test Skill rules registry.
- `ff1cffa0f999c7ba6822a58e14cc983efe6ee694` — corrected audited Skill rule details.
- `8326d938b7f175b66a0d9ddf85c316b594bafd7e` — StandardTestSkillResolver.
- `ddb15c624dfea3b67300104ae2b32ec46e8333a2` — named Standard Tests registry.
- `44b2c61145b7bf827f08822b4fdc17eeda94df51` — register named tests.
- `cf353ae3f209498b67de411897f51dc5b9dc104f` — Polish named-test localization.
- `553ca7c6122eec5c693bae4463f10c2e029f46fd` — English named-test localization.
- `21df464e0e9c532870cdb1f741b0c28001a986d1` — core Skill identity catalog.
- `0b20e3faf24038612f094e76ce566500a9dbcd04` — Skill Item sheet identity selector support.
- `2158a02f777379e4e3710f86f71c212df8898840` — Skill sheet `rulesId` select field.
- `9ce0fd13c4803a177beb3d062469eafad52c95da` — Skill Item CSS for new field.
- `3342669ef6ea44c9678f2dcd864bd97592d2bdc4` — Polish Skill identity/localization labels.
- `73a883a5af4e130f1a94afd5ee60c60648f3bceb` — English Skill identity/localization completion.

User live-tested the Skill Item rules-identity selector and confirmed that the selected value persists after closing/reopening the Skill Item sheet.

### Current UI issue found at end of session

The Skill Item popup works functionally, but the current color palette has poor contrast in the native `<select>` option list. The option text is barely readable against the dropdown background.

User would like a cohesive old-parchment / black-ink visual style for Skill and roll/test popup windows, visually related to the Classic character sheet.

Agreed direction:

- First fix readability/contrast immediately.
- Then define a reusable themed popup style for Skill and test/roll dialogs.
- Possible generated assets: parchment modal background, inked frame/header, button/input textures, subtle dividers.
- Avoid over-relying on image assets when CSS is better.
- Native `<select>` dropdown lists are partly OS/Electron controlled and may not accept full visual theming; a custom dropdown/list may eventually be preferable for the Standard Test selector if consistent parchment styling is desired.

No themed asset pack has been integrated yet.

## Immediate next steps

Recommended order for the next session:

1. **Fix Skill Item select contrast/readability** in `css/sheets/skill-item.css` and live-test it.
2. Decide whether to create the reusable parchment/black-ink popup theme now or after the first Standard Test dialog is functional.
3. Build the visible `🎲 TEST STANDARDOWY` launcher at the top of the first Skills column.
4. Build the initial named Standard Test selection/configuration dialog using the audited registry.
5. Connect `StandardTestSkillResolver` so only owned Skills with stable `rulesId` appear as candidates; do not auto-enable situational skills.
6. Add the already-agreed roll visibility selector (Public default, Private GM, Blind GM, Self) through the existing TestContext/TestResult/ChatMessage pipeline using Foundry-native roll modes.
7. Runtime-test representative Standard Tests in Foundry v14.

## Important implementation cautions

- Fetch latest `master` before every edit.
- Do not infer a Skill mechanic from its name.
- Existing Skill Items with blank `rulesId` remain valid custom/unlinked Skills.
- Do not automatically convert old localized Skill names to rules IDs by guessing.
- Standard Test skill bonuses may be fixed, conditional, derived, target-affecting, or procedure-specific; do not flatten them into a universal `+10` model.
- `TestResult` remains generic; combat-specific critical/damage semantics stay out of it.
- Foundry live runtime behavior is the final authority for UI/API behavior.

## Session end state

The project is in a good stopping point:

- Classic page-1 alignment is much improved and user-approved for the current pass.
- Skill rules identity persists correctly in live Foundry.
- Standard Tests backend foundations are in place.
- The next visible feature is the Standard Tests launcher/dialog, preceded by the small Skill popup readability fix.

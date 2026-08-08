# Session Handoff

**Date:** 2026-08-08  
**Purpose:** Temporary handoff for the next working session. Replace/update this file at the end of future sessions rather than creating additional overlapping progress documents.

## Current working source

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub `master` is the current implementation source of truth. Before modifying anything, fetch the latest `master` version of the exact file and its dependencies.

**Last gameplay/UI commit live-tested by the user:** `2953dd2c174ec4e2a17f39702d1fa2fa491b0dca` — `Use Foundry v14 ChatMessage context hook`.

The user confirmed at the end of the session that the current Standard Test result-visibility workflow is working correctly.

## Rulebook policy reminder

Official rulebooks are **not stored in Git**. For any new WFRP mechanics audit or implementation, the English and Polish WFRP 1e Core Rulebooks must be available separately in the working context. Do not infer mechanics from current code, memory, later editions, or fan summaries.

Authority order:

1. English WFRP 1e Core Rulebook — mechanics.
2. Polish WFRP 1e Core Rulebook — official Polish terminology and translation comparison.
3. Original Polish character-sheet scan — Classic-sheet visual authority.

This is especially important for the next requested movement-related Standard Tests (`Skok` / `Zeskok`). Do not implement their mechanics until the relevant English and Polish rulebook sections are available and checked.

## Session results

### 1. Standard Test launcher on the Classic Character Sheet

The dedicated `🎲 TEST STANDARDOWY` launcher is now implemented and live-tested.

Final user-approved presentation:

- It is an intrinsic built-in action, not an owned Skill Item.
- It occupies the **first actual writable row** in the first `UMIEJĘTNOŚCI` column.
- Owned Skills continue underneath it, with overflow continuing into the second column.
- It no longer overlaps the printed `UMIEJĘTNOŚCI` heading.
- Extra indentation was removed so the full label fits.
- It has a subtle background/border treatment so it is distinguishable from normal owned Skills without looking like a floating button.

The user explicitly confirmed the final button/alignment as correct.

Relevant final commits include:

- `2ba9110` — align Standard Test with first skill row.
- `9e21760` — refine Standard Test skill-row styling.

### 2. Standard Test configuration is now a single dialog

The previous two-step flow was refactored.

Current UX:

`🎲 TEST STANDARDOWY` → choose named Standard Test + required context + general modifier → `Rzuć`

There is no unnecessary second generic modifier popup for a Standard Test.

Architecture remains modular:

- `TestDialog` still owns generic modifier parsing/application.
- `StandardTestDialog` composes the Standard-Test-specific controls and the generic modifier in one UI.
- `RollTestAction` can execute an already-configured context without reopening the generic dialog.

Relevant commits:

- `05562a7` — extract reusable test modifier configuration.
- `ee199db` — support preconfigured test modifiers.
- `d31e99a` — compose Standard Test into one roll dialog.
- `587ac95` — preserve Standard Test modifier in pending requests.

### 3. Standard Test conditional fields are working

The Foundry v14 `DialogV2` lifecycle issue was fixed by attaching listeners at the rendered-dialog stage rather than to the detached HTMLElement that Foundry stringifies.

Live-tested behavior now includes:

- ordinary tests such as `Budowa`, `Strach`, `Głupota` → only the Standard Test selector plus generic controls;
- `Ukrywanie się` → target context;
- `Słuchanie` → base Listen chance/noise input;
- `Otwieranie zamków` → lock difficulty input.

Relevant fix:

- `c7785e9` — fix Standard Test dialog field updates.

### 4. Deferred target resolution replaces hard target errors

Target-dependent Standard Tests no longer throw an error when no token is pre-targeted.

Current workflow:

- If exactly one target Token is already selected, the test proceeds normally.
- If target data is missing, the test creates a pending chat request instead of throwing.
- GM can resolve the pending target by:
  - using the current targeted Token;
  - choosing a world Actor, including an off-scene Actor;
  - drag/drop of an Actor or Token onto the pending card;
  - manually entering the single required target characteristic value.
- Current audited target-dependent examples:
  - `Ukrywanie się` requires target `I`;
  - `Przekupstwo` requires target `SW/WP`.
- After target resolution, the existing `Actor.rollTest(...)` pipeline resumes.
- The already-entered general modifier is preserved.

Important implementation lesson preserved from this session:

- Do **not** pass frozen objects into Foundry Document data/`ChatMessage.flags`; Foundry v14 DataModel cleaning reconstructs/mutates supplied object graphs.
- Internal rule definitions may remain immutable, but data crossing into Foundry Documents must be mutable JSON-safe data.

There was one temporary syntax regression in `PendingStandardTest.mjs` during this work; it was restored and the final mutable-flags correction was reapplied safely. The Classic sheet and pending flow were subsequently live-tested successfully.

Relevant recovery/final commits:

- `9513f77` — restore parsing pending Standard Test module.
- `870279a` — fix pending Standard Test mutable chat flags.

### 5. Test result chat card redesigned

The previous expanded result layout was rejected visually and replaced with a compact WFRP-style result card.

Current collapsed hierarchy:

- test name;
- success/failure badge;
- prominent final target (`Próg`);
- roll;
- margin.

Clicking the target can reveal a compact detailed calculation when the current visibility policy allows it.

The result layout no longer uses a table, which prevents legacy sheet-wide table typography rules from corrupting chat-card fonts/layout.

A dedicated scoped stylesheet is used for the result card.

Relevant commits:

- `63529b3` — redesign test result chat-card layout.
- `754f536` — add scoped test-result chat styling.
- `85226d1` — load scoped test-result chat styles.

### 6. Target calculation breakdown

The expanded result view is derived from the same resolved test/context data and does not own or recalculate mechanics independently.

It can show:

- formula-derived base target;
- formula inputs;
- characteristic base value for direct characteristic tests;
- rule/default/Skill/context modifiers;
- general test modifier;
- total modifier;
- final target.

Mechanical invariant preserved:

`base target + enabled modifiers = final target`

Formula presentation is localized and uses Classic-sheet characteristic abbreviations rather than raw resolver identifiers.

Example Polish presentation:

- raw internal formula: `i + cl - target.i`
- displayed formula: `I + Op - Cel.I`

The resolver formula itself is unchanged; this is presentation only.

Relevant commit:

- `81b2b56` — localize formula abbreviations in test breakdown.

### 7. Pure chance targets display as percentages

Tests that represent a direct percentage chance rather than a characteristic-derived target are now formatted with `%` in the result card.

Example:

- `Ryzyko` base target displays as `50%`;
- after `-30`, final target displays as `20%`.

Characteristic-derived formulas continue to display as normal target numbers rather than percentages.

Relevant commits:

- `57b3e8d` — add chance formatting and chat presentation helpers.
- `62c81b1` — format pure chance targets and hide GM diagnostics.

### 8. General test modifier is always present and GM-editable after the roll

The generic `Modyfikator testu` now has a stable internal identity and is present even when its value is `0`.

In the expanded result card:

- players can see the modifier only when the visibility policy permits the detailed breakdown;
- GM can edit the general test modifier directly in chat.

Changing it does **not** reroll the d100.

The result chat snapshot preserves:

- original d100 roll;
- resolved base target;
- other modifier contributions;
- general modifier;
- formula/input presentation needed for the diagnostic card.

A GM edit recalculates only:

- final target;
- success/failure;
- margin;

against the original d100 roll.

This prevents later Actor-sheet changes from retroactively changing an old roll's base calculation.

Relevant commits in this feature chain include:

- `0590ee5` — publish editable test-result chat cards.
- `b6b3977` — show editable general modifier.
- `1acd74a` — style GM-editable modifier.
- `0a2b94f` — activate result chat controls.
- `454891b` — keep fallback result rendering compatible.

### 9. Result-detail visibility is now controlled by the GM

The session ended with this workflow live-tested and user-approved.

There are currently two **calculation-detail** visibility modes:

1. `Tylko MG` / `GM only` — default.
   - Players see the compact result only.
   - Players cannot expand the target calculation.
   - The breakdown DOM is removed on non-GM clients, preventing indirect inference of opponent characteristics through values such as `Próg bazowy`.
   - GM always retains the full calculation and editable modifier.

2. `Publiczne (pełne)` / `Public (full)`.
   - Players may expand and inspect the complete target calculation.

This visibility is deliberately separate from Foundry's ChatMessage roll/message visibility (`Make Private`, blind roll, self roll, etc.).

GM control exists at two points:

- **Before rolling:** GM test dialogs contain a `Szczegóły wyniku` selector.
- **After rolling:** right-click the result ChatMessage and switch between:
  - `Szczegóły testu: udostępnij graczom`;
  - `Szczegóły testu: tylko MG`.

Player-created tests are forced to the safe default (`Tylko MG`); a player cannot force public diagnostic details by passing an option through a macro.

For target-dependent tests, the chosen detail visibility survives the pending-target flow.

The initial post-roll context-menu integration used an obsolete/wrong hook. It was corrected to the Foundry v14 hook:

`getChatMessageContextOptions`

The user then live-tested the right-click visibility switch and explicitly confirmed that it is working correctly.

Relevant commits:

- `e969761` — add test-result visibility contract.
- `7d7e8aa` — add visibility to generic test dialog.
- `af7f144` — add visibility to Standard Test dialog.
- `06e9786` — add per-result detail visibility controls.
- `a2c4c2a` — wire per-result visibility into chat.
- `2bcbcf3` — preserve result visibility in pending tests.
- `9a43d81` — style locked player result details.
- `ac858a1` — enforce GM control of result visibility.
- `2953dd2` — use Foundry v14 `getChatMessageContextOptions` hook.

### 10. Opponent information policy established

Current approved presentation policy:

- GM can inspect the full formula and opponent/target statistics in the detailed result calculation.
- Player access to those diagnostics is controlled by the GM through the per-result visibility policy.
- Default is `Tylko MG` to avoid leaking NPC/opponent statistics.
- If GM explicitly sets `Publiczne (pełne)`, the full calculation is intentionally public.

Important technical distinction:

The current protection is a **client presentation boundary**, not cryptographic secrecy. Shared ChatMessage flags/content may still contain diagnostic data. If hard data secrecy from technically sophisticated player clients becomes a requirement, opponent diagnostics must later move into GM-only storage rather than only per-client rendered visibility.

## Standard Test status at session end

User-confirmed working pieces:

- Classic-sheet `🎲 TEST STANDARDOWY` row placement and styling.
- Single-window Standard Test configuration.
- Conditional context fields.
- General modifier in the same dialog.
- Deferred target workflow instead of hard errors.
- Pending target resolution by current target / Actor / drag-drop / manual characteristic.
- Compact result chat card.
- Expandable diagnostic target calculation for GM.
- Localized characteristic abbreviations in displayed formulas.
- Percentage formatting for pure chance tests such as `Ryzyko`.
- Always-present general modifier in the result snapshot.
- GM post-roll modifier editing with fixed original d100 roll.
- GM-only vs public-full result-detail visibility.
- Post-roll right-click visibility switching through the Foundry v14 ChatMessage context menu.

## Important items NOT completed yet

### `Skok` / `Zeskok`

The user requested that movement-related `Skok` / `Zeskok` procedures appear through the same Standard Test launcher.

They are **not implemented yet**.

Reason: their WFRP mechanics must be verified against both official core rulebooks before implementation. The rulebook PDFs are not tracked in Git and were not available in the active implementation context during this session.

Do not model these as generic percentage tests from memory.

### StandardTestSkillResolver UI integration

The backend `StandardTestSkillResolver` / stable Skill `rulesId` foundation exists from the previous session, but the full UI flow for presenting potentially applicable owned Skills and letting the GM/player decide which actually apply is still not integrated into the final Standard Test dialog/result path.

Preserve the earlier design decision:

- the system may identify candidate Skills;
- it must **not automatically decide situational applicability** where the WFRP rule leaves that decision to the GM.

### Foundry-native message/roll visibility

The new `Szczegóły wyniku` setting controls **calculation detail visibility only**.

It is not the same as Foundry's native roll/message modes such as:

- public roll;
- GM/private roll;
- blind GM roll;
- self roll.

Those native roll modes remain a separate future integration concern and should not be conflated with `GM only` vs `Public (full)` diagnostic detail visibility.

### NPC/creature sheets

The audited custom Classic sheet is still registered for Character Actors. Do not register the Character sheet for NPC/creature Actor types simply to expose Standard Test controls.

The Standard Test action architecture should be reused when dedicated NPC/creature sheets/data models are implemented.

## Immediate next steps

Recommended order when resuming:

1. Fetch latest `master` and verify the working checkpoint starts from at least gameplay commit `2953dd2` plus this handoff update.
2. Ask for / obtain the English and Polish WFRP 1e Core Rulebooks before changing movement mechanics.
3. Audit and implement `Skok` / `Zeskok` as Standard-Test-launcher procedures using the verified rulebook contract rather than forcing them into an inappropriate generic formula.
4. Then return to `StandardTestSkillResolver` UI integration so candidate owned Skills can participate in Standard Tests without automatic situational decisions.
5. After those pieces are stable, decide whether to add Foundry-native roll/message mode selection to the test dialogs as a separate concern from result-detail visibility.
6. Continue representative live Foundry v14 tests after each dependency-ordered change.

## Important implementation cautions

- Fetch latest `master` before every edit.
- Do not infer WFRP mechanics from current formulas or names when the rulebook has not been checked.
- Do not pass frozen object graphs into Foundry Document/ChatMessage data.
- Keep internal immutable rule definitions separate from mutable Foundry Document payloads.
- Do not couple chat presentation to mechanic recalculation.
- Result-card GM modifier edits must preserve the original d100 roll and resolved base snapshot.
- Result-detail visibility and Foundry message/roll visibility are separate concepts.
- Do not leak opponent statistics by default through either direct target rows or indirectly derivable base-target diagnostics.
- Use Foundry v14-specific hooks/APIs; the working ChatMessage context hook is `getChatMessageContextOptions`.
- Foundry live runtime behavior remains the final authority for UI/API behavior.
- Avoid creating additional overlapping progress/state documents; update this `SESSION_HANDOFF.md` at session end.

## Session end state

This is a good stopping point.

The Standard Test launcher, configuration flow, deferred target handling, result card, GM modifier adjudication, and per-result diagnostic visibility are all at a user-tested working checkpoint.

The final live test in this session confirmed that the GM can right-click a completed result and successfully change whether the detailed calculation is visible to players.

No further gameplay implementation should be started until the next dependency is deliberately chosen and, for mechanics such as `Skok` / `Zeskok`, the required English and Polish rulebook sections are available for verification.

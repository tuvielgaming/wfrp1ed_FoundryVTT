# Session Handoff

**Date:** 2026-09-14  
**Purpose:** This is the **single current continuation/source-of-truth document** for future ChatGPT sessions working on this repository. Do not create competing handoff/progress documents. Read this file first, then inspect current `master` before changing code.

## Repository / authority

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`  
Target: Foundry VTT v14  
System: Warhammer Fantasy Roleplay 1st Edition  
Primary presentation: Polish Classic Character Sheet

Current GitHub `master` is authoritative for code. This file is authoritative for current continuation context, architecture decisions, runtime verification state, protected regressions, and the next pending runtime test.

Older stable references remain useful for deeper historical/rules detail:

- `PROJECT_STATE.md`
- `RULEBOOK_IMPLEMENTATION.md`
- `FOUNDRY_V14_GUIDELINES.md`

Do not infer current implementation status from those files when this handoff says otherwise.

---

# Mandatory workflow

1. Inspect current `master` first. Never reconstruct current source from memory or an older chat.
2. Before modifying an existing file:
   - fetch current `master` HEAD;
   - fetch the exact current file and blob SHA;
   - inspect surrounding implementation and direct consumers.
3. Push directly to `master` unless the user explicitly requests another workflow.
4. Make small dependency-ordered commits/checkpoints.
5. After each runtime-relevant checkpoint provide commit SHA, exact files changed, rationale, and exact Foundry verification steps.
6. **Do not call anything runtime-verified until the user explicitly tests it and says `Verified` / `verified`.**
7. If a test fails, diagnose source before adding another patch. Do not stack competing mechanisms.
8. Preserve existing user-authored layout/visual work unless the task requires changing it.
9. Foundry v14 APIs are authoritative; avoid deprecated APIs.
10. For WFRP mechanics, English WFRP 1e Core is primary mechanics authority and Polish Core is terminology/localization authority. Verify sources before changing rules.
11. `packs/` output is generated locally and gitignored.
12. This is a from-scratch system. Current test Actors/Tokens are disposable. Do **not** add migration compatibility solely for test data unless explicitly requested.

---

# Current runtime state

## Latest runtime-verified implementation baseline

```text
a50aa4d0d95499994aec4f6b2f161f3ecf84dcd9
Own Character Creation default in Actor lifecycle
```

User runtime-verified that a brand-new Character opens directly in Character Creation Mode and the existing mode toggle still works.

Everything through this implementation commit is runtime-verified unless a specific section below says otherwise.

## Current unverified implementation checkpoint

```text
1175243d85962ee9f34be46fe6c4feecd0b4c91e
Align adversary sheet with parchment window contract
```

This checkpoint adds the first native NPC/Creature Actor architecture and **has not been runtime-verified yet**.

The current repository HEAD can be newer than the implementation checkpoint because this handoff is maintained in separate documentation commits. Documentation-only commits do not require Foundry runtime verification.

## Failed Character Creation default attempts — historical only

Do **not** treat either of these as the working design:

```text
68698b6f26bff49f6fe2f2cf8600f495aba91fdd
Enable Character Creation Mode for new Characters

912f3e6b3a29b2a14fd1068cb931b7496cb593dd
Force Character Creation Mode for new PCs
```

Both global `preCreateActor`-hook approaches failed runtime verification. The successful design owns the mandatory default in the WFRP Actor document lifecycle and modifies pending source with `updateSource`.

---

# Immediate continuation: native NPC / Creature checkpoint

The user previously confirmed that `npc` and `creature` Actors opened only Foundry fallback sheets. We deliberately did **not** register the Character sheet for them.

## Architecture decision

NPC and Creature share the WFRP **adversary profile/combat domain**:

- the canonical 14-characteristic WFRP profile;
- remaining Wounds and derived Wounds maximum;
- armour points by hit location;
- Insanity, Magic Points and Power Level;
- embedded Skills, Weapons, Armour, Equipment, Traits and Spells;
- existing characteristic-roll/combat document APIs where compatible.

They deliberately do **not** own Character-only concepts:

- Career progression;
- Experience accounting/advancement;
- Character Creation Mode;
- Career history/exits;
- Fate-generation workflow.

For this first slice, `AdversaryData` has neutral zero-valued `purchased` and `career` characteristic fields because several current shared profile helpers expect the Character-shaped characteristic record. They are compatibility structure only and are **not** exposed as NPC/Creature advancement mechanics. Do not add XP advancement UI for adversaries.

We intentionally did not refactor verified `CharacterData` in the same checkpoint. A future common profile base can be considered only after the adversary slice is stable.

## Files introduced

```text
module/data-models/actor/AdversaryData.mjs
module/sheets/AdversaryActorSheet.mjs
templates/actors/adversary/adversary-sheet.hbs
css/sheets/adversary-actor.css
module/adversaries/AdversaryBootstrap.mjs
```

`system.json` now loads `AdversaryBootstrap.mjs` and `adversary-actor.css`.

`AdversaryBootstrap.mjs` registers:

```text
CONFIG.Actor.dataModels.npc = AdversaryData
CONFIG.Actor.dataModels.creature = AdversaryData
```

and makes `AdversaryActorSheet` the default sheet for `npc` and `creature`.

The sheet opts into the existing canonical `wfrp1ed-parchment-window` visual contract rather than inventing a separate parchment theme.

## Commit chain for this unverified slice

```text
40b74a1aad3e8bce3c56f636b0e20b069bae6e1f  Add native NPC and Creature profile data model
ea3854942749679a7521ecd00577f8409949765a  Add native NPC and Creature actor sheet
1406227d6f88b96a72d5af121585c6886b81219c  Add NPC and Creature sheet template
1dd750cd7d3955d3604ba224e1a3b05373fdaf40  Style native NPC and Creature sheet
3a3e58768c469a12b33cf95e901417ec59b1ee49  Register native NPC and Creature actor architecture
8635bdf0bb12ce4dd7d10a11455e87fd5c00c33e  Load native NPC and Creature sheets
7ef71f3898cec19d55a73392aff543b060f0443a  Use canonical parchment theme for adversary sheets
1175243d85962ee9f34be46fe6c4feecd0b4c91e  Align adversary sheet with parchment window contract
```

## Required runtime verification before further risky work

After a full Foundry restart, delete/recreate disposable test objects and test **new** NPC and Creature Actors:

1. Create a new NPC and a new Creature.
2. Both must open the WFRP-owned parchment adversary sheet, not Foundry fallback.
3. Confirm the type label differs correctly (`BN/NPC` versus `Stworzenie/Creature`).
4. Edit name and `Gatunek / Typ`; close/reopen and confirm persistence.
5. Confirm all 14 characteristics appear in canonical order: `M, WS, BS, S, T, W, I, A, Dex, Ld, Int, Cl, WP, Fel` (localized labels/abbreviations as appropriate).
6. Edit several characteristic base values; close/reopen and confirm persistence.
7. Set Wounds characteristic and remaining Wounds; confirm `current / max` reflects the characteristic maximum correctly.
8. Click a rollable characteristic such as WS/WW and verify it uses the existing characteristic-roll/chat pipeline.
9. Movement, Wounds and Attacks must not expose d100 roll buttons.
10. Edit Magic Points, Power Level, Insanity and armour points; close/reopen and confirm persistence.
11. Use `+` in Skills, Weapons, Armour, Equipment, Traits and Spells. A new embedded Item should be created and its Item sheet should open.
12. Close the Item sheet and confirm the Item is listed in the correct adversary section.
13. Click an Item name to reopen it.
14. Delete an Item and confirm the confirmation dialog and deletion work.
15. Reopen the adversary Actor and confirm embedded Items persist.
16. Confirm there are **no** Career, Experience or Character Creation controls.
17. Open a normal Character and verify the Classic Character Sheet and automatic Character Creation Mode still behave as before.
18. Console should remain clean.

Do **not** claim drag/drop authoring onto the adversary sheet yet. It was not implemented/audited in this first slice; test it separately after the basic native sheet is stable.

### Runtime concern to remember

`Wfrp1edActor.prepareDerivedData()` still has a legacy profile path for `npc`. Native `AdversaryData` already derives the same `current = initial + purchased * advanceStep` fields, so the duplicate legacy calculation should currently be harmless for NPC and does not run for Creature. If runtime exposes a discrepancy, fix the document/model ownership at the source instead of patching the UI.

---

# Identity architecture

Use explicit domain identities; do not create a new generic `rulesId` architecture.

Canonical direction:

- Skill -> `skillId`
- Race -> `raceId`
- Career -> `careerId`
- Language -> `languageId`
- Psychology -> `psychologyId`
- Disease -> `diseaseId`
- Spell -> `spellProcedureId`
- weapons/armour/equipment use their own structured identity

For specialised Skills canonical identity is:

```text
skillId + specialisation
```

Rules:

- custom Skills may have blank `skillId`;
- never infer canonical identity from localized/user-editable names;
- avoid UUID/name fallback changes without a separate audit because embedded copies get new UUIDs;
- Career generic grants include non-Skill document types, so generic grant `rulesId` cannot be blindly renamed.

`SkillData` still temporarily exposes a compatibility `rulesId` getter backed by `skillId`; remove only after all direct consumers migrate.

## Skill specialisation

`CoreSkillSpecialisationCatalog` is the single source of finite canonical Skill specialisation options.

Current catalog-driven specialised Skills include:

- Specialist Weapon / Specjalna broń
- Secret Language / Sekretny język
- Arcane Language / Język tajemny

Career authoring and ordinary Skill Item editing consume the same catalog. Future Skills with finite canonical choices should require only catalog data, not another Skill-specific UI patch. Runtime-verified.

---

# Experience architecture

Established WFRP 1e decisions:

- Characteristic advance = 100 EP.
- Career Skill = 100 EP.
- Do not invent a generic increased-cost off-Career Skill rule.
- Cross-class Basic Career entry may cost 200 EP according to existing Career transfer policy.
- Teacher/training availability is narrative permission, not a generic Intelligence roll.
- Initial Career/package acquisition is Character Creation, not a paid Career Transfer.

## Durable transaction service

Runtime-verified behavior:

- first advancement in an open Character Sheet starts a durable transaction;
- Characteristic, Career Skill and Career Transfer events are prepared before mutation and marked applied after;
- supported current-session purchases can be undone;
- normal sheet close commits to persistent ledger;
- stale/crashed open transactions roll back;
- exact pre-transaction XP/state is restored;
- current-session purchases are visibly marked;
- Career rollback removes later dependent purchases while preserving earlier purchases.

Key verified commits:

```text
53681bddf724df6c4ef668cd3f80dd18c081b19d  Characteristic transactions
39aa671cf89781f2b3d4d24cef8b98b8609522dc  Career Skill transactions
0f944ff96cadcaed2225a213fb9225e462688d8f  Career change transactions
d5736ac0775d6dd88db6034221abf3c8acdf530e  Career rollback presentation
```

## Experience Log / ledger

Verified behavior:

- separate `Dziennik PD / Experience Log` window;
- Current / Total / Spent summary;
- committed transactions newest first;
- open log updates live when Actor XP/ledger changes;
- GM manual signed entries with description;
- negative correction cannot make Total lower than Spent;
- manual description can be edited without changing historical amount;
- automated purchase rows remain protected;
- direct edits of Current/Total on Character Sheet are audited as ledger corrections.

Relevant verified commits:

```text
0ad445e50264559143c1e24ddf311b1c92896119  Experience Log
b84b8a2e0b4b426316478eca064a8320b69725f7  Live log refresh
9f89d202e8d5f6471594b64a5be4d537ca3306df  Manual ledger controls
3e503f3fecd06c520f1ed7767779ff745d99fac5  Input replace-on-focus fix
bb3812e1caf4b68c5ae13bebc4b0e799e48bbcfb  Audited Current/Total corrections
```

All XP accounting mutations should go through established Experience services rather than parallel ledger writes.

---

# Claimable XP awards through Chat

Implemented and runtime-verified end-to-end.

GM:

- open Experience Log;
- choose `Przyznaj PD przez czat / Award XP in chat`;
- enter positive XP amount;
- reason is mandatory;
- explicitly select entitled player-owned Character Actors;
- post persistent chat card.

Player:

- owner sees `Odbierz / Claim` for entitled Actor;
- each entitled Actor can claim exactly once;
- award goes through `ExperienceLedgerService`;
- exact GM reason is written to Actor ledger;
- ChatMessage persists claimed state.

Integrity:

- primary active GM is authoritative for socket-driven claim mutation;
- message stores recipient claim state;
- Actor ledger stores award identity, preventing duplicate grant even after partial failure/retry;
- one user owning multiple entitled Actors may claim once per Actor;
- no second XP accounting system exists in chat integration.

Relevant files:

```text
module/experience/ExperienceAwardChatIntegration.mjs
module/experience/ExperienceLedgerService.mjs
```

---

# Character Actor / Token identity policy

For player Characters:

```text
sidebar world Actor
== linked scene Token Actor
== Actor opened by double-clicking that Token
```

Every newly created `character` Actor defaults to:

```text
prototypeToken.actorLink = true
```

This was runtime-verified.

Do not redirect XP awards to arbitrary synthetic token Actors. Chat awards target canonical world Character Actors.

NPC/Creature token policy remains separate; this first adversary checkpoint does not force linked-token behavior for them.

Implementation:

```text
module/tokens/CharacterPrototypeTokenDefaults.mjs
```

---

# Character Creation Mode architecture

Authoritative flag:

```text
flags.wfrp1ed.characterCreationMode
```

Core UI/state integration:

```text
module/creation/CharacterCreationModeIntegration.mjs
```

The mode is functional state, not only presentation. Existing creation tooling consumes it, including Race-driven generation and initial Career assignment/package acquisition.

Initial Career package acquisition is Character Creation and remains separate from normal XP purchases. Do not create a generic “Creation Mode means all progression is free” shortcut.

The GM can explicitly toggle the mode with the existing scroll/header control.

## New-Character default — VERIFIED

Every newly created `character` Actor enters Character Creation Mode automatically.

The working implementation is owned by the WFRP Actor document lifecycle, not a global `preCreateActor` hook:

```text
a50aa4d0d95499994aec4f6b2f161f3ecf84dcd9
Own Character Creation default in Actor lifecycle
```

Runtime verification confirmed:

- brand-new Character opens in Creation Mode;
- creation presentation is active;
- existing scroll/header toggle can disable and re-enable the mode;
- linked Character prototype-token default remains intact.

Do not restore either failed hook-based implementation.

---

# Canonical UI contracts

## Inputs

System-owned editable value inputs use the global replace-on-first-focus behavior (`SelectAllOnFocus.mjs`). First typing replaces the old value; a deliberate second click permits caret editing. New system DialogV2/ApplicationV2 content should use the normal `.wfrp1ed` ownership class so it inherits canonical system behavior where applicable.

## Checkboxes

Use canonical `.wfrp1ed-checkbox` / WFRP checkbox integration rather than browser-default checkbox presentation.

Global implementation:

```text
css/forms/checkbox.css
module/ui/SystemCheckboxIntegration.mjs
```

Checkbox presentation uses `currentColor`, so it remains visible on parchment and dark DialogV2 surfaces. Runtime-verified.

## Parchment application theme

Small/native WFRP ApplicationV2 windows that need the standard parchment treatment should opt into:

```text
wfrp1ed-parchment-window
```

from `css/sheets/parchment-window.css` rather than inventing per-sheet parchment backgrounds. The new adversary sheet follows this contract.

## Wounds

Editable `current / max` and read-only `current/max` must share the same center in the Classic Żw cell. Runtime-verified at `84bf5c46...`.

## Current Career transaction marker

During an open Career transfer:

- Current Career geometry must not move;
- green indication must not disturb layout;
- minus badge sits immediately left of Career action badge;
- Shift-click is rollback affordance.

Runtime-verified.

---

# Career architecture

Implemented now (do not rely on obsolete August handoff statements):

- initial Career assignment/replacement during Character Creation;
- free initial Career package acquisition;
- active Career Advance Scheme application;
- Career Skill offers and 100 EP purchases;
- Career Transfer policy/cost/restrictions;
- 100/200 EP transfer costs according to rule policy;
- durable Career Skill and Career Transfer transactions;
- rollback/current-session indicators;
- progression-owned Career history/exits.

Identity migration debt remains separate: some Career/reference code still contains transitional `rulesId` fallback paths. Audit deliberately; do not bulk-rename generic grants.

---

# Protected regressions / boundaries

- Classic Character Sheet registration/context/render has prior regression history; avoid broad rewrites for narrow tasks.
- Do not revive old chat compatibility hacks without a concrete reproduced issue.
- Skill specialisation is catalog-driven; do not re-hardcode Specialist Weapon-only behavior.
- Standard Tests have explicit protected Skill identity behavior; do not replace with broad inference without audit.
- Global input-focus, checkbox, and parchment-window integrations are canonical; new UIs should join those contracts instead of creating local duplicates.
- XP accounting mutations belong to Experience services.
- Chat XP awards target canonical world Character Actors.
- New Character tokens are linked by default.
- Character Creation default belongs to the WFRP Actor lifecycle; do not reintroduce failed global `preCreateActor` default hooks.
- NPC/Creature use dedicated adversary architecture; do not register the Character sheet for them or add Character Career/XP controls.
- Current test NPC/Creature data is disposable; no migration layer is needed unless the project later reaches release data compatibility requirements.

---

# Recent verified continuation chain

Not exhaustive; only the recent chain most relevant to continuation:

```text
551df7844b07f9075752773325adab17f21f114e  v14 TextEditor drag data
6c7cc5a5a46e8ffb2112f11a3856b7f2ca7c804e  Race mandatory Skill threshold guard
489df063acb7e4dc8986a1ede2d563aa84ed7621  Canonicalize Career Skill grants to skillId
e0a1d15c946d4733f3f981378d874fb4a69de92b  v14 drag compatibility + Career Skill tooltip
53681bddf724df6c4ef668cd3f80dd18c081b19d  Characteristic transactions
39aa671cf89781f2b3d4d24cef8b98b8609522dc  Career Skill transactions
d6ae20f99a02c72463b291a43bd29f77970a35b5  Current transaction indicator
0f944ff96cadcaed2225a213fb9225e462688d8f  Career change transactions
d5736ac0775d6dd88db6034221abf3c8acdf530e  Career transaction presentation
4add39460357f5b70825805e6768e1417009ed61  Generalized Skill specialisation authoring
0ad445e50264559143c1e24ddf311b1c92896119  Experience Log
b84b8a2e0b4b426316478eca064a8320b69725f7  Live Experience Log refresh
9f89d202e8d5f6471594b64a5be4d537ca3306df  Manual Experience ledger controls
3e503f3fecd06c520f1ed7767779ff745d99fac5  Canonical input focus in Experience dialog
bb3812e1caf4b68c5ae13bebc4b0e799e48bbcfb  Audited direct XP field corrections
cf5bcfd8b05f521cb04f3a83578dea3b2256718c  Character linked-token default loaded
84bf5c46b2930c8a3d423449312f4d94da9c5009  Theme-aware checkbox + centered read-only Wounds
a50aa4d0d95499994aec4f6b2f161f3ecf84dcd9  Character Creation default owned by Actor lifecycle
```

Failed historical attempts after `84bf5c46...`:

```text
68698b6f26bff49f6fe2f2cf8600f495aba91fdd  FAILED: first Character Creation default hook
912f3e6b3a29b2a14fd1068cb931b7496cb593dd  FAILED: second Character Creation default hook
```

Current unverified adversary chain ends at:

```text
1175243d85962ee9f34be46fe6c4feecd0b4c91e  Native NPC/Creature model + sheet loaded, awaiting runtime verification
```

---

# Next implementation order

1. Runtime-test the native NPC/Creature checkpoint through `1175243d...` with newly created disposable Actors.
2. If verified, make `1175243d...` the new runtime implementation baseline and update this handoff.
3. Audit adversary drag/drop and item-authoring parity with Character only after the basic sheet is stable.
4. Audit remaining NPC/Creature combat/status integration differences revealed by runtime tests; fix document/model ownership rather than UI patches.
5. Decide NPC/Creature token-link policy separately from Character token policy.
6. Return to remaining Character Creation / Career identity debt only after adversary checkpoints are stable.

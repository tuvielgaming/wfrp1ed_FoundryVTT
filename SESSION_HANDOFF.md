# Session Handoff

**Date:** 2026-09-14  
**Purpose:** This is the **single current continuation/source-of-truth document** for future ChatGPT sessions working on this repository. Do not create competing handoff/progress documents. Read this file first, then inspect current `master` before changing code.

## Repository / authority

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`  
Target: Foundry VTT v14  
System: Warhammer Fantasy Roleplay 1st Edition  
Primary presentation: Polish Classic Character Sheet

Current GitHub `master` is authoritative for code. This file is authoritative for current continuation context, architecture decisions, runtime verification state, protected regressions, and the next pending implementation slice.

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

User runtime-verified that a brand-new Character now opens directly in Character Creation Mode and the existing mode toggle still works.

Everything through this implementation commit is runtime-verified unless a specific section below says otherwise.

The current repository HEAD may be newer than the implementation baseline because `SESSION_HANDOFF.md` itself is maintained in separate documentation commits. Documentation-only handoff commits do not require Foundry runtime verification.

## Failed Character Creation default attempts — historical only

Do **not** treat either of these implementations as the working design:

```text
68698b6f26bff49f6fe2f2cf8600f495aba91fdd
Enable Character Creation Mode for new Characters

912f3e6b3a29b2a14fd1068cb931b7496cb593dd
Force Character Creation Mode for new PCs
```

Both `preCreateActor`-hook approaches failed runtime verification: newly created Characters still opened in normal mode.

The successful design moved this mandatory default into the WFRP Actor document lifecycle (`Wfrp1edActor._preCreate` path), where pending document source is modified with `updateSource`.

---

# Immediate continuation: native NPC / Creature architecture

User runtime test confirmed that `npc` and `creature` Actors currently open only Foundry fallback sheets.

Current source facts:

- `module/wfrp1ed.mjs` registers `ClassicActorSheet` only for `types: ["character"]`.
- Current comments explicitly leave unaudited Actor subtypes on Foundry Core sheets.
- `template.json` contains a legacy `npc` contract.
- `system.json` exposes `creature` as an Actor type, but there is no corresponding proper audited native Creature data model/sheet.
- Current `Wfrp1edActor` legacy profile preparation covers `character` and `npc`, not a complete Creature contract.

Therefore the next task is **not** to register the Character sheet for NPC/Creature as a shortcut.

Next dependency-ordered work:

1. Audit WFRP 1e Core requirements for NPC and Creature records against current repository data usage.
2. Decide shared profile primitives vs subtype-specific fields.
3. Add native Foundry v14 Actor data model(s) for NPC/Creature as appropriate.
4. Add proper system-owned NPC/Creature sheet presentation in small checkpoints.
5. Register those sheets only after their data contract exists.
6. Runtime-test newly created NPC and Creature Actors.

No migration compatibility is needed for existing test NPCs/Creatures; they may be deleted and recreated.

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

NPC/Creature token policy remains separate and should be decided during the native NPC/Creature audit.

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

Every newly created `character` Actor now enters Character Creation Mode automatically.

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

System-owned editable value inputs use the global replace-on-first-focus behavior (`SelectAllOnFocus.mjs`). First typing replaces the old value; a deliberate second click permits caret editing. New system DialogV2 content should use the normal `.wfrp1ed` root so it inherits this behavior.

## Checkboxes

Use canonical `.wfrp1ed-checkbox` / WFRP checkbox integration rather than browser-default checkbox presentation.

Global implementation:

```text
css/forms/checkbox.css
module/ui/SystemCheckboxIntegration.mjs
```

Checkbox presentation uses `currentColor`, so it remains visible on parchment and dark DialogV2 surfaces. Runtime-verified.

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
- Global input-focus and checkbox integrations are canonical; new UIs should join those contracts.
- XP accounting mutations belong to Experience services.
- Chat XP awards target canonical world Character Actors.
- New Character tokens are linked by default.
- Character Creation default belongs to the WFRP Actor lifecycle; do not reintroduce the failed global `preCreateActor` default hooks.
- NPC/Creature native sheets are currently **missing** and must be implemented as a deliberate data/sheet architecture slice, not by pretending they are Characters.

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

---

# Next implementation order

1. Start from verified implementation baseline `a50aa4d0...` and current `master`.
2. Audit native NPC/Creature Actor data requirements against WFRP 1e Core and existing subsystem consumers.
3. Define native NPC/Creature data model architecture before registering a sheet.
4. Implement proper system-owned NPC/Creature sheet(s) in small dependency-ordered checkpoints.
5. Runtime-test newly created NPC/Creature Actors.
6. Return to remaining Character Creation / Career identity debt only after those Actor checkpoints are stable.
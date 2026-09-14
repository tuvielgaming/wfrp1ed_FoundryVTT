# Session Handoff

**Date:** 2026-09-14  
**Purpose:** This is the **single current continuation/source-of-truth document** for future ChatGPT sessions working on this repository. Do not create competing progress/handoff documents. Read this file first, then inspect current `master` before making any change.

## Repository / authority

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`  
Target: Foundry VTT v14  
System: Warhammer Fantasy Roleplay 1st Edition  
Primary presentation: Polish Classic Character Sheet

GitHub/current `master` is authoritative for code. This file is authoritative for **continuation context, architecture decisions, workflow, verified checkpoints, protected regressions, and the next pending runtime test**.

Older stable design/rules references remain in:

- `PROJECT_STATE.md`
- `RULEBOOK_IMPLEMENTATION.md`
- `FOUNDRY_V14_GUIDELINES.md`

Do not infer current implementation state from those older documents when this file says otherwise.

---

# Mandatory implementation workflow

1. **Inspect current `master` first.** Never reconstruct source from memory or an older chat.
2. Before modifying an existing file:
   - fetch current `master` HEAD;
   - fetch the exact current file and blob SHA;
   - inspect the surrounding implementation and related consumers.
3. Push directly to `master` unless the user explicitly requests another workflow.
4. Make small dependency-ordered commits/checkpoints.
5. After each runtime-relevant checkpoint provide:
   - commit SHA;
   - exact files changed;
   - what changed and why;
   - exact Foundry runtime verification steps.
6. **Do not call anything runtime-verified until the user explicitly tests it and says `Verified`/`verified`.**
7. If a test fails, diagnose the source before adding another patch. Do not stack competing mechanisms.
8. Preserve existing user-authored visual/layout work unless the task explicitly requires changing it.
9. Foundry v14 APIs are authoritative. Avoid deprecated Foundry APIs.
10. For WFRP mechanics, English WFRP 1e Core is primary mechanical authority; Polish Core is terminology/localization authority. Verify source material before changing a rule.
11. `packs/` output is generated locally and gitignored; do not treat generated packs as source files.
12. The project is being built from scratch. Current test Actors/Tokens may be deleted/recreated. **Do not add migration/compatibility machinery solely for disposable test data unless explicitly requested.**

---

# Current baseline

## Latest runtime-verified baseline

```text
84bf5c46b2930c8a3d423449312f4d94da9c5009
Center read-only Wounds display
```

Everything through this commit has been runtime-verified by the user unless a specific section below says otherwise.

## Current `master` after the latest unverified implementation

```text
68698b6f26bff49f6fe2f2cf8600f495aba91fdd
Enable Character Creation Mode for new Characters
```

This latest commit is **NOT runtime-verified yet**. The next action must be to test it before starting another risky feature.

---

# Immediate continuation / next runtime test

The latest change makes every newly created `character` Actor start with Character Creation Mode enabled.

Test after a full Foundry restart:

1. Create a **new Character Actor**.
2. Open the sheet.
3. Confirm Character Creation presentation is already active and the scroll/header control indicates Creation Mode is enabled.
4. Add a Race as appropriate and confirm creation-only Race controls become available.
5. Disable Character Creation Mode using the scroll/header control:
   - normal presentation returns;
   - creation-only controls disappear.
6. Enable it again:
   - creation presentation and controls return.
7. Create a new NPC or Creature:
   - it must **not** automatically enter Character Creation Mode.
8. Confirm the new Character still has `prototypeToken.actorLink = true` and a scene token opens the same canonical Actor.

If the user says `Verified`, make `68698b6...` the new runtime baseline and continue the Character Creation audit from there.

---

# Identity architecture

Use explicit domain identities; do not introduce a new generic `rulesId` architecture.

Canonical direction:

- Skill -> `skillId`
- Race -> `raceId`
- Career -> `careerId`
- Language -> `languageId`
- Psychology -> `psychologyId`
- Disease -> `diseaseId`
- Spell -> `spellProcedureId`
- Weapons/armour/equipment use their own structured identity as appropriate

For specialised Skills the canonical identity is:

```text
skillId + specialisation
```

Rules:

- custom Skills may have blank `skillId`;
- never infer canonical identity from localized/user-editable names;
- avoid UUID/name fallback changes without a separate audit, because embedded copies receive new UUIDs;
- Career generic grants include non-Skill document types, so generic `rulesId` fields cannot be blindly renamed.

`SkillData` still temporarily exposes a compatibility `rulesId` getter backed by `skillId`; remove it only after all direct consumers are migrated.

## Core Skill specialisations

`CoreSkillSpecialisationCatalog` is the single source for finite canonical Skill specialisation choices.

Current catalog-driven specialised Skills include at least:

- Specialist Weapon / Specjalna broń
- Secret Language / Sekretny język
- Arcane Language / Język tajemny

Both Career authoring and ordinary Skill Item editing consume the same catalog. Future Skills with a finite canonical choice list should require only a catalog entry, not another Skill-specific UI patch.

This generalized ordinary Skill-sheet behaviour was runtime-verified.

---

# Experience architecture

## WFRP 1e rule decisions already established

- Characteristic advance: 100 EP.
- Skill from current/new Career: 100 EP.
- No invented generic Core rule for buying arbitrary off-Career Skills for increased XP.
- Cross-Career-Class entry into a Basic Career uses the explicit 200 EP surcharge where the existing Career policy determines it.
- Training/teacher availability is narrative permission, not a generic Intelligence roll.
- Initial Career assignment is character creation, not a paid Career Transfer.

## Durable Experience transaction service

The system uses a durable Actor-backed Experience transaction model for purchases made during an open Character Sheet session.

Required behaviour, runtime-verified:

- first advancement opens a transaction;
- Characteristic, Career Skill and Career Transfer events are prepared before mutation and marked applied afterwards;
- individual current-session purchases can be undone independently where supported;
- normal sheet close commits the open transaction to the persistent ledger;
- stale/crash/reload open transactions roll back instead of silently committing;
- rollback restores exact pre-transaction XP/state;
- current-session purchased items/advances are visibly highlighted;
- Characteristic repeated purchase indicator may show `−2`, etc.;
- Career change rollback removes dependent later purchases while preserving earlier purchases in the same session.

Runtime-verified transaction checkpoints include:

```text
53681bddf724df6c4ef668cd3f80dd18c081b19d  Characteristic transactions
39aa671cf89781f2b3d4d24cef8b98b8609522dc  Career Skill transactions
0f944ff96cadcaed2225a213fb9225e462688d8f  Career change transactions
d5736ac0775d6dd88db6034221abf3c8acdf530e  Career rollback presentation alignment
```

## Experience Log / persistent ledger

The read-only Experience Log became the persistent audit surface and was then extended with GM accounting operations.

Verified behaviour:

- separate `Dziennik PD / Experience Log` window;
- Current / Total / Spent summary;
- committed advancement transactions newest first;
- open log rerenders automatically when relevant Actor XP/ledger data changes;
- manual signed GM entries with mandatory/meaningful description;
- manual negative corrections cannot make Total lower than Spent;
- manual-entry descriptions are editable without changing the historical amount;
- automated mechanical purchase rows remain protected;
- direct GM edits of Total and Current on the Character Sheet are now audited as explicit ledger corrections instead of silent mutations.

Relevant verified commits:

```text
0ad445e50264559143c1e24ddf311b1c92896119  Read-only Experience Log
b84b8a2e0b4b426316478eca064a8320b69725f7  Live Experience Log refresh
9f89d202e8d5f6471594b64a5be4d537ca3306df  Manual ledger controls
3e503f3fecd06c520f1ed7767779ff745d99fac5  Global replace-on-focus in Experience dialog
bb3812e1caf4b68c5ae13bebc4b0e799e48bbcfb  Audited direct Current/Total corrections
```

Input UX rule: system-owned editable value inputs should use the existing global replace-on-first-focus behaviour (`SelectAllOnFocus.mjs`), with a second deliberate click allowing normal caret editing. New system dialogs must use the normal `.wfrp1ed` root so they inherit this behaviour.

---

# Claimable XP awards through Chat

This workflow is implemented and runtime-verified end-to-end.

GM workflow:

- open Experience Log;
- choose `Przyznaj PD przez czat / Award XP in chat`;
- enter positive XP amount;
- **reason is mandatory**;
- explicitly choose entitled player-owned Character Actors;
- post a persistent chat card.

Player workflow:

- an owner sees `Odbierz / Claim` for an entitled Actor;
- each entitled Actor may claim exactly once;
- claim grants XP through `ExperienceLedgerService`;
- the exact GM reason is written to that Actor's ledger;
- chat card persists claimed state.

Integrity architecture:

- primary active GM is authoritative for socket-driven claim mutation;
- ChatMessage stores recipient claim state;
- Actor ledger also stores the award identity, so a retry cannot double-grant even if message-state update is interrupted;
- one user owning multiple entitled Actors may claim once for each Actor;
- XP award chat integration does not maintain a second accounting system.

Relevant implementation:

```text
module/experience/ExperienceAwardChatIntegration.mjs
module/experience/ExperienceLedgerService.mjs
```

The XP chat mechanics were functionally confirmed, then checkbox/token issues were fixed and the complete slice was verified through `84bf5c46...`.

---

# Character Actor / Token identity policy

For player Characters, common-sense Foundry behaviour is required:

```text
sidebar Character Actor
== linked scene Token Actor
== Actor opened by double-clicking that Token
```

Therefore every newly created `character` Actor defaults to:

```text
prototypeToken.actorLink = true
```

This was runtime-verified.

Do not change XP awards to target arbitrary synthetic Token Actors. Awards target the canonical world Character Actor.

NPC/Creature/etc. token-link policy is not forced by this Character rule.

Because this system is being built from scratch, do not add migration tooling for old unlinked test Character tokens unless explicitly requested.

Implementation:

```text
module/tokens/CharacterPrototypeTokenDefaults.mjs
```

---

# Character Creation Mode

Authoritative mode flag:

```text
flags.wfrp1ed.characterCreationMode
```

Implementation:

```text
module/creation/CharacterCreationModeIntegration.mjs
```

The mode already existed before the current checkpoint and is consumed by creation tooling. It is not merely visual.

Existing creation architecture includes Race-driven generation such as:

- starting characteristic generation;
- starting Skills;
- age/height/secondary details where implemented;
- Career Class handling;
- random initial Career from Race tables;
- free initial Career package acquisition (Skills/trappings/magic where defined).

Important boundary:

- initial Career/package acquisition is **character creation**, not a zero-cost version of normal XP advancement;
- do not route normal Characteristic/Career Skill/Career Transfer purchases through a generic “free because Creation Mode” shortcut without an explicit audited design;
- GM can explicitly toggle Creation Mode with the existing scroll/header control.

Current unverified change:

```text
68698b6f26bff49f6fe2f2cf8600f495aba91fdd
Enable Character Creation Mode for new Characters
```

No migration logic was added; only new Character creation defaults are affected.

---

# Canonical UI contracts / presentation rules

## Checkboxes

All system-owned custom sheets/dialogs/popups/configuration windows must use the canonical `.wfrp1ed-checkbox` contract or `WfrpCheckbox` helper rather than raw browser-specific presentation.

Global checkbox geometry lives in:

```text
css/forms/checkbox.css
module/ui/WfrpCheckbox.mjs
module/ui/SystemCheckboxIntegration.mjs
```

The global checkbox presentation is theme-aware via `currentColor`, so it remains visible on parchment and Foundry dark DialogV2 surfaces. This was runtime-verified.

## Wounds display

Editable Wounds (`current / max`) and read-only `current/max` must share the same visual centre in the Classic Żw cell.

The read-only value spans the entire three-column Wounds grid. Runtime-verified at:

```text
84bf5c46b2930c8a3d423449312f4d94da9c5009
```

## Current Career transaction indicator

During an open Career-transfer transaction:

- normal Current Career geometry must not move;
- green transaction indication must not disturb layout;
- minus badge sits immediately left of the existing Career action/roll badge;
- Shift-click remains the rollback affordance.

Runtime-verified at `d5736ac...`.

---

# Career state / architecture

Career progression is no longer at the old August-stage described by previous handoff text.

Implemented architecture now includes:

- initial Career assignment/replacement during character creation;
- initial Career package acquisition;
- active Career Advance Scheme application;
- Career Skill offers and 100 EP purchases;
- Career Transfer policy/cost/restriction path;
- 100/200 EP Career transfer costs according to the existing rule policy;
- durable Career Skill and Career Transfer Experience transactions;
- rollback/current-session indicator behaviour;
- Career history/exits derived from progression rather than free Actor text.

Do not reintroduce the old statement that Career Transfer or Advance Scheme replacement are “not implemented”.

Identity migration debt remains separate: some Career/reference code still has transitional `rulesId` fallback paths. Audit those deliberately; do not bulk-rename generic Career grants because trappings and other non-Skill types share parts of the grant schema.

---

# Protected regressions / do not casually change

- Classic Character Sheet registration/context/render path has previous regression history. Avoid broad sheet rewrites for narrow features.
- Chat compatibility regression was previously fixed; do not revive old chat hacks without a concrete reproduced problem.
- Specialist Weapon / Skill specialisation behaviour is now catalog-driven. Do not re-hardcode Specialist Weapon-only logic.
- Standard Tests have protected explicit Skill identity behaviour; do not replace it with broad catalog inference without a separate audit.
- Existing global input-focus and checkbox systems are canonical; new dialogs should join those contracts instead of adding local duplicate handlers/styles.
- Experience accounting mutations should go through the established Experience services rather than writing parallel ledger structures.
- Chat XP grants target canonical world Character Actors, not arbitrary scene synthetic Actors.

---

# Relevant verified recent commit chain

This is not an exhaustive repository history; it is the recent continuation chain most likely needed by a future session.

```text
551df7844b07f9075752773325adab17f21f114e  Foundry v14 TextEditor drag data
6c7cc5a5a46e8ffb2112f11a3856b7f2ca7c804e  Race mandatory Skill threshold guard verified
489df063acb7e4dc8986a1ede2d563aa84ed7621  Canonicalize Career Skill grants to skillId
e0a1d15c946d4733f3f981378d874fb4a69de92b  v14 drag compatibility + Career Skill tooltip verified
53681bddf724df6c4ef668cd3f80dd18c081b19d  Characteristic Experience transactions verified
39aa671cf89781f2b3d4d24cef8b98b8609522dc  Career Skill Experience transactions verified
d6ae20f99a02c72463b291a43bd29f77970a35b5  Current-transaction indicator verified
0f944ff96cadcaed2225a213fb9225e462688d8f  Career change transactions verified
d5736ac0775d6dd88db6034221abf3c8acdf530e  Career transaction presentation verified
4add39460357f5b70825805e6768e1417009ed61  Generalized Core Skill specialisation authoring verified
0ad445e50264559143c1e24ddf311b1c92896119  Experience Log verified
b84b8a2e0b4b426316478eca064a8320b69725f7  Live Experience Log refresh verified
9f89d202e8d5f6471594b64a5be4d537ca3306df  Manual Experience ledger controls verified
3e503f3fecd06c520f1ed7767779ff745d99fac5  Replace-on-focus Experience dialog verified
bb3812e1caf4b68c5ae13bebc4b0e799e48bbcfb  Audited direct XP corrections verified
cf5bcfd8b05f521cb04f3a83578dea3b2256718c  XP chat award + linked Character token implementation functionally verified
84bf5c46b2930c8a3d423449312f4d94da9c5009  Checkbox theme + read-only Wounds presentation verified
68698b6f26bff49f6fe2f2cf8600f495aba91fdd  New Characters default to Creation Mode — NOT YET VERIFIED
```

---

# Future-session startup checklist

A future chat should do this before implementation:

1. Read `SESSION_HANDOFF.md`.
2. Fetch current `master` HEAD and confirm whether it moved beyond the commit recorded here.
3. If current HEAD differs, inspect intervening commits/files before assuming this handoff is complete.
4. Check the **Immediate continuation / next runtime test** section.
5. Do not begin the next feature while the latest checkpoint is still unverified unless the user explicitly redirects the work.
6. For any edit, fetch the current target file + SHA first.
7. After a successful runtime verification, update this handoff when the accumulated state materially changes or before ending/handing off a long implementation session.

# Session Handoff

**Date:** 2026-08-14  
**Purpose:** Single current implementation/architecture checkpoint. Do not create competing progress documents.

## Source of truth

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub/current `master` is authoritative. Fetch the exact current file + blob SHA before every write and preserve user commits/visual adjustments.

Latest implementation commit before this handoff save:

```text
7d4216326f941009b639690c2acf3a9a23285d7e
Load Career Item sheet integration
```

Important user-authored visual commits to preserve:

```text
d07a488171e7d58981b55b2fa724b81ee2e42ece  Attack debt marker position fix
84108b417bcae42666182e45292b3efb051fca3f  Player edit toggle style update
308b5fdd996a3683e67da68e096f0eb9c79cc347  Adjust melee weapon table top display
39a9b2bb288e74f5e451fcde9e08780b67806ec6  Crit wound placement
91b3fd95b3d4300b51ef1cd0a45fecff19249892  Small Wound lock marker alignment
```

Older stable architecture/rule decisions remain documented in:

```text
PROJECT_STATE.md
RULEBOOK_IMPLEMENTATION.md
FOUNDRY_V14_GUIDELINES.md
```

This file is only the current continuation checkpoint.

---

# Immediate continuation

The most recent work moved from combat QoL into the Career subsystem.

**First action next session:** pull current `master`, restart Foundry, then runtime-test the new Career Item assignment flow before extending Career mechanics.

Test:

1. Character sheet editing OFF → dropping a Career Item must not assign/replace the initial Career.
2. Editing ON and no XP has ever been spent → dropping a Career Item assigns it as Initial/Current Career.
3. Drop a second Career Item before XP spending → it replaces the first character-creation choice; Career History remains a single entry for the newly selected initial Career.
4. Spend the first XP on a real advancement → initial Career becomes permanently locked.
5. Undo that XP purchase so current spent XP can return to zero → initial Career must remain locked; character creation must not reopen.
6. Re-enable sheet editing later and drop another Career → it must be rejected and reserved for the future paid Career Transfer workflow.
7. Current Career and Career Class on the Classic header must be linked/read-only, not free text.

Do not yet implement Career Transfer, Career Exits automation, or Career Advance Scheme replacement until the Career Item data model is audited against the Core rules.

---

# Career design — CURRENT DECISION

Initial Career selection is part of **character creation**, not an XP-paid career transfer.

The user explicitly requires the same edit gate as initial characteristic values:

```text
sheet editing OFF
→ initial Career cannot be assigned/replaced

sheet editing ON + XP spending has never begun
→ Career Item may be dropped to assign/replace the initial Career
```

Initial Career may therefore be corrected during character creation, including replacing a mistaken first choice.

Once the first XP points are actually spent, initial-career replacement is permanently closed. This is a lifecycle boundary, not merely a check that `experience.spent > 0` right now. Undoing/refunding the first XP purchase must not reopen character creation.

The free pre-adventure advance is not XP spending and therefore does not itself lock initial Career selection.

Current Career must not be free text. Career identity belongs to a Career Item. Legacy Actor string fields may temporarily survive for migration compatibility but must not remain authoritative.

Career History is progression-owned:

- first entry = final initial Career chosen during character creation;
- discarded character-creation Career choices are not history;
- later Careers are appended only by a successful Career Transfer transaction.

Career Exits are also progression-owned and should come from the active Career Item rather than manual Actor text.

The Classic Career History and Career Exits rows are display summaries only; manual `+` / remove controls were removed.

Recent Career commits:

```text
c3b9d4a26a458a08723a97e32e6ab4e00dff80c9  Make career history and exits read-only summaries
3680166271b7ded29ce39e6e1007e7115a2c7827  Link initial career assignment to Career Items
7d4216326f941009b639690c2acf3a9a23285d7e  Load Career Item sheet integration
```

Current Career integration module:

```text
module/careers/CareerSheetIntegration.mjs
```

Current limitations intentionally left for next Career audit:

- legacy Career Item is not yet a complete audited native Career data model;
- Career Exits are not yet canonical Career references;
- Career Advance Scheme is not yet automatically applied from the Career Item;
- Career Transfer rules/costs are not implemented yet;
- Current Career / Career Class legacy Actor fields still exist for migration compatibility.

---

# Combat Tracker / turn order — runtime-confirmed

Initiative dragging/postponement now works correctly according to user runtime testing.

Persistent round-completion state is independent of initiative order:

```text
flags.wfrp1ed.roundTurnState = {
    round,
    completed
}
```

Contract:

- drag/reorder never completes a turn;
- only Next Turn completes the focused Combatant's turn;
- postponing the active Combatant transfers focus to the next unfinished Combatant;
- temporary initiative order resets at the next round;
- initiative lifecycle owner survives reorder correctly.

The user confirmed dragging and initiative-order change are now working correctly.

---

# Parry / Dodge — current state

## Core/default Parry interpretation

Rulebook interpretation remains:

- Parry is a WS test;
- successful Parry reduces the damaging blow by `1d6`;
- at most `A` Parry attempts per round;
- ordinary Parry loses the next Attack whether successful or failed;
- Shield Parry gives `+20 WS` and loses all following attacks;
- if the relevant following attacks occur in the next round/turn opportunity, default mode carries bounded debt forward.

Important clarified example:

```text
A=2 actor acts first
→ voluntarily ends turn without attacking
→ later parries with ordinary weapon
→ unused attacks from the finished turn are not a bank of reactions
→ parry costs the actor's next attack opportunity, therefore 1 debt into next turn
```

Shield after a completed turn analogously removes all next following attacks, so an `A=2` actor can begin the next turn effectively at `0/2`.

The user re-confirmed this interpretation after reviewing the rule logic; no change requested.

## Default debt marker

Debt marker lifecycle requirement:

```text
debt created
→ survives round end
→ survives next round start
→ debt is paid when affected turn begins
→ marker stays visible during that actor's turn to explain reduced A
→ marker disappears only when that actor clicks Next Turn
```

Relevant recent fixes:

```text
ebc28e3254af0cb84d3c5e6fbbac972e4b34cbe4  Preserve parry debt reminder through round transition
35f8538e23b59ebf777d3c022bc3fe4100a0ba2d  Keep parry debt badge across initiative focus changes
ecc7e8a8e26b0ea250c7e47b63f17868dbd45c07  Tie parry debt badge to real turn completion
f04fe3a90205069ee23a213a60b19cb069f2a93b  Refresh parry debt badge after reminder update
```

## Optional round-contract Parry

Optional world rule remains distinct from default:

- no future parry debt;
- ordinary weapon Parry consumes one current-round A;
- Shield Full Defence commits remaining offensive A for the round;
- total Parry attempts are still capped by permanent A;
- state resets on Next Round.

---

# Character-sheet defence shortcuts — IMPLEMENTED

When a successful melee attack is waiting for defence, the target Actor's Classic sheet exposes the same legal defence choices directly on the relevant sheet entries:

- Dodge Blow skill, when legal;
- equipped legal parry weapon;
- equipped legal Shield.

Clicking the sheet entry calls the same authoritative defence transaction as the Chat dropdown; it is not a second defence system.

Normal Chat dropdown + Confirm Defence remains available.

For multiple unresolved successful melee attacks against the same Actor, sheet defence always resolves the **latest unresolved attack first**. After resolution, the sheet recalculates and the next click can resolve the previous unresolved attack.

Example:

```text
Attack 1 pending
Attack 2 pending
click Axe → resolves Attack 2
click Axe again → resolves Attack 1, if still legal after resource recalculation
```

Relevant commits:

```text
df4d69ae656d6db90ace48fe23509d0c205be8cb  Add character sheet defence shortcuts
39f12e9818391fa25e305cbbbc2ee6358e511ce2  Load character sheet defence shortcuts
41054529dc7c6ef3c615a5e3db35deb44062140d  Style character sheet defence shortcuts
ef545bb0c03c0691ade33f198ee57bc4d65e94e8  Load character sheet defence styles
2db7f3b3287db442a00dbeb3ed24c5807fc44d93  Resolve latest pending defence from character sheet
```

---

# Combat transaction rollback — IMPLEMENTED, partly runtime-confirmed

GM mistake correction uses reversible combat transactions with Actor-local LIFO safety.

## Defence rollback

GM may invalidate the latest valid Defence transaction for that Actor.

Invalidation:

- leaves the Test message in Chat and marks it INVALIDATED;
- refunds the exact recorded defence-resource state rather than guessing `+1 A`;
- restores Dodge availability / parry resource / debt / Shield commitment as appropriate;
- reopens the linked original attack to pending defence;
- character-sheet defence shortcuts become available again after recalculation.

The first rollback implementation had a Foundry recursive-merge bug: deleting nested `attackState.defence` from a cloned flag did not reliably remove the old resolved defence object. This was fixed by explicitly replacing it with `null`, plus a startup repair for already-stuck invalidated transactions.

Relevant commits:

```text
dbafa4fc90350ae8baddb75ae425ef704506453f  Add safe LIFO combat transaction rollback
4857631d0cc03ecfbf6637e72726c7613ded0f8f  Style invalidated combat transactions
be6067986f50af8c5607cb75629bec84ec6b7ddb  Load combat rollback and header guard
a58d10aaab437bfce9b8d528c73a649970ff5695  Reopen rolled-back defence state reliably
77bf303d3e4b095868442ff81a6d45a9f294a9aa  Load defence rollback update guard
f80c546b3c754d870316d22ca1012cf81fb0af42  Repair previously stuck invalidated defences
```

User runtime result at session end:

**Defence invalidation/reopen is working correctly for the tested case.**

## Damage rollback design

Rollback architecture also supports latest applied Damage transaction for an Actor.

Intended cascade when invalidating a Defence with downstream applied damage:

```text
Critical created by that DamagePacket
→ revert/remove exact critical consequence
→ restore Wounds from recorded before/after state
→ mark damage transaction REVERTED with visible information
→ refund defence resource
→ reopen original attack
```

Rollback must not be silent. Chat/notifications should explain what was reverted.

Safety rule: current state must still match the expected post-transaction state; otherwise rollback refuses and asks GM to revert newer dependent transaction first.

**Important:** defence rollback itself was runtime-tested, but automatic rollback of subsequent applied damage/critical has NOT yet been runtime-confirmed by the user.

---

# Header Career `+` bug — RESOLVED BY DESIGN CHANGE

The Career History / Career Exits `+` controls were causing Character header sibling fields to be erased because `details` is a native SchemaField and partial nested updates could be cleaned as replacements.

A guard was initially added, but the user correctly questioned why these controls should exist at all.

Final direction:

- remove manual Career History `+` / remove controls;
- remove manual Career Exits `+` / remove controls;
- render both as progression-owned read-only summaries;
- Current Career is also no longer intended to be free text and is now linked from the active Career Item.

`CharacterDetailsUpdateGuard.mjs` remains loaded for compatibility/safety but manual career-list editing is no longer the desired workflow.

---

# Existing foundations to preserve

Do not regress these established decisions:

- WFRP 1e authenticity first; English Core controls mechanics, Polish Core controls Polish terminology.
- Classic sheet visually follows the original paper sheet.
- Foundry V14 native architecture and APIs should be used rather than legacy patterns when audited replacements exist.
- Generic Test engine remains the single d100 resolution engine; combat must not create a parallel percentile roller.
- Attack/defence procedure can work outside Combat Tracker; Tracker adds automation, not permission to perform the core procedure.
- Wounds never persist below zero; overflow becomes critical value.
- Combat damage and critical provenance must remain traceable for safe rollback.
- GM/Actor-owner visibility boundaries on test and defence mechanics remain as implemented.
- Equipped melee row interaction remains:

```text
left-click         → attack / defence shortcut when a legal pending defence owns the click
Shift + left-click → open Item
```

- Manual/physical d100 editing remains auditable and recalculates from persisted Test snapshot.
- Current `A` sheet display stays simple (`2/2`, `1/2`, `0/2`) with default-mode debt reminder layered beside it.

---

# Recommended next work order

1. Runtime-test the new initial Career Item assignment/replacement/lock lifecycle.
2. Audit the Career Item against English + Polish WFRP 1e Core:
   - Career Class;
   - Advance Scheme;
   - Skills;
   - trappings where relevant;
   - Career Exits;
   - Basic vs Advanced Career identity;
   - stable Career references for exits.
3. Implement a native Career data model / sheet contract.
4. Make active Career drive Current Career, Career Class, Advance Scheme and Career Exits.
5. Only then implement paid Career Transfer as a real XP transaction and Career History append.
6. Separately, when combat damage integration reaches the point where downstream damage can follow a defence, runtime-test the automatic Defence → Damage → Critical rollback cascade.

Do not reintroduce free-text Current Career or manual Career History/Career Exits editing as a temporary shortcut.

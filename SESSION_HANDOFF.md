# Session Handoff

**Date:** 2026-08-15  
**Purpose:** Single current implementation/architecture checkpoint. Do not create competing progress documents.

## Source of truth

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub/current `master` is authoritative. Fetch the exact current file + blob SHA before every write and preserve user commits/visual adjustments.

Latest implementation commit before this handoff save:

```text
653cde793e1379d107010711317ff5f1369b0c0f
Move adjudication rebuilds to the authoritative client
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

The latest session returned to the combat Damage → Critical → persistent consequence → rollback lifecycle and fixed four runtime problems found during player/GM testing.

**First action next session:** pull current `master`, fully restart Foundry so all changed ES modules reload, then runtime-test the combat fixes below before doing more implementation work.

Test in this order:

1. Generate a **fresh Leg #7** detailed Critical and apply the Critical Wound.
   - proper Core injury description must be visible;
   - Critical Wounds window must show `Efekty: 1`;
   - one managed Active Effect must exist;
   - for the test Ork shown during this session, `Sz 3 → 1` and `I 27 → 13` are expected under the agreed flooring behavior.

2. Invalidate that damage.
   - linked Critical Wound disappears;
   - its managed Active Effect disappears with the Item;
   - Movement and Initiative return to their original values;
   - Wounds restore from the recorded transaction.

3. Generate a lethal detailed Critical.
   - resolving the table result alone must not mark the Actor Dead;
   - applying the fatal consequence must mark Dead/Defeated according to the fatal lifecycle;
   - **Invalidate Damage** must restore Wounds, revert the fatal application and remove the derived Dead/Defeated mark.
   - if a Fate Point has already been spent for that fatal transaction, damage rollback is intentionally blocked until Fate rollback exists/is performed.

4. As a Player, adjudicate a Parry Test from failure → success after the attack damage die has already been rolled.
   - no permission/database error should appear on the Player client;
   - the original attack damage die must be preserved;
   - if the newly successful Parry has no existing reduction die, lifecycle must move to the normal `Roll Parry Reduction 1d6` stage rather than rerolling attack damage.

5. Apply Damage from the Player-facing damage card.
   - damage applies exactly once;
   - `Apply Damage` / `Zastosuj obrażenia` must disappear after authoritative state refresh on both GM and Player;
   - if a stale copy survives for one render frame and is clicked again, the click must be harmless/idempotent and must not produce the previous `damage packet has already been applied` error.

After this combat verification pass, return to the Career Item assignment runtime test saved below unless a combat regression remains.

---

# Combat damage / detailed Critical lifecycle — LATEST SESSION

The user runtime-tested a damage result which generated a Leg #7 Critical Wound and found four distinct issues:

1. invalidating damage after an applied lethal Critical restored Wounds/removed the Critical consequence but left the Actor marked Dead;
2. a generated Leg #7 Critical Wound displayed no proper Core description and `Efekty: 0`, therefore Movement and Initiative were not affected;
3. when a Player edited their Parry Test from failure to success, their client logged Foundry permission/database errors even though the attack lifecycle continued;
4. after applying damage, the `Apply Damage` button could remain rendered, and clicking it again produced `This damage packet has already been applied to the target Actor.`

These were treated as separate lifecycle defects rather than patched as one UI symptom.

## Fatal consequence rollback now belongs to damage rollback

Damage rollback now inspects the linked fatal application transaction. If the DamagePacket owns an applied fatal Critical consequence, rollback also changes that fatal application to `reverted`, restores Wounds, and then asks the fatal-status integration to recompute the derived Dead/Defeated state.

Safety boundary:

```text
fatal consequence applied
+ Fate Point already spent for that packet
→ damage rollback refuses
```

A permanent Fate expenditure must never be silently undone by a lower-level Damage rollback.

Commit:

```text
208169b2e540829ca278c39702bff1e2e0f4a90d  Revert fatal consequences with damage rollback
```

Expected lifecycle:

```text
Damage applied
→ lethal detailed Critical resolved
→ fatal consequence applied
→ Actor marked Dead/Defeated
→ Invalidate Damage
→ Wounds restored
→ fatal application reverted
→ derived Dead/Defeated status removed
```

## Persistent Critical Wounds now store effectNumber directly

Root cause of the Leg #7 `Efekty: 0` defect was provenance loss.

The detailed resolver knew the result was Leg effect #7, but the persistent Critical Wound originally stored only RollTable UUID/result provenance and not the resolved `effectNumber` itself. A Player can own the Actor while lacking permission/visibility to read the system-managed RollTable, so the Player-side consequence builder could not reliably reconstruct `#7` and concluded that no automatic Core effect existed.

New boundary:

```text
resolved detailed Critical
→ persistent Critical Wound stores effectNumber directly
→ automatic consequence generation reads persisted effectNumber first
→ RollTable lookup is migration fallback only
```

Relevant commits:

```text
b77b9491703a7f9fdb36ac68e2204d48ffdacaab  Persist detailed critical effect number on wounds
651796d18dcfcfe1bd1567a9a13aadfb89226797  Use persisted critical effect numbers for wound effects
ce78a90e3e0a9d218488806e4ecc6e74b304bf3e  Read persisted effect numbers on critical wound sheets
```

Current Core automatic characteristic mapping deliberately includes Leg #5, #6 and #7 because they halve Movement and Initiative until medical attention. Leg #4 remains intentionally unautomated for now because it lasts D4 rounds and applying it indefinitely would be wrong without an authoritative duration-expiration lifecycle.

For Leg #7 a newly created wound should therefore contain one managed Active Effect with two rule changes:

```text
Movement × 0.5
Initiative × 0.5
```

The Critical Wound Item sheet should also resolve the correct Core text from the persisted effect number without depending on Player access to the managed RollTable.

## Defence adjudication reconciliation is now single-writer

The Player-side console errors came from every connected client reacting to the same `updateChatMessage` hook and attempting to mutate the authoritative attack ChatMessage. The GM succeeded, so lifecycle continued, while the Player often lacked permission to perform the same write and saw noisy Foundry errors.

New rule:

```text
active GM exists
→ only primary active GM mutates authoritative combat damage/adjudication state

no active GM
→ only a client that can actually update the source message may mutate it
```

The reconciliation layer also preserves the previously rolled attack-damage die when a later defence Test is adjudicated. Failure → successful Parry therefore changes only the dependent stages; it must never become a way to reroll known attack damage.

Relevant commits:

```text
dd66f4c766d7141445d6483b7918004c4a645c18  Restrict combat damage reconciliation to authority
653cde793e1379d107010711317ff5f1369b0c0f  Move adjudication rebuilds to the authoritative client
```

## Apply Damage is now idempotent at the Chat boundary

The Actor damage application transaction remains authoritative. A visible button can survive for one render frame after another client has already applied the packet. Previously that stale UI click entered `DamageApplication.apply()` and raised an already-applied error even though no duplicate damage was possible.

Now `DamageChat.applyMessage()` first checks the authoritative Actor transaction. If the packet is already `applied`, it refreshes Actor-targeting damage cards/chat and returns the existing transaction instead of reporting an error.

Successful first application also requests broader Chat refresh so Player and GM result cards converge more reliably.

Commit:

```text
a39ad6d787d62ba0a37e6ef28dee8568b4c3616f  Make damage application UI idempotent
```

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

## Pending Career runtime test

After the current combat lifecycle fixes are verified, test:

1. Character sheet editing OFF → dropping a Career Item must not assign/replace the initial Career.
2. Editing ON and no XP has ever been spent → dropping a Career Item assigns it as Initial/Current Career.
3. Drop a second Career Item before XP spending → it replaces the first character-creation choice; Career History remains a single entry for the newly selected initial Career.
4. Spend the first XP on a real advancement → initial Career becomes permanently locked.
5. Undo that XP purchase so current spent XP can return to zero → initial Career must remain locked; character creation must not reopen.
6. Re-enable sheet editing later and drop another Career → it must be rejected and reserved for the future paid Career Transfer workflow.
7. Current Career and Career Class on the Classic header must be linked/read-only, not free text.

Do not yet implement Career Transfer, Career Exits automation, or Career Advance Scheme replacement until the Career Item data model is audited against the Core rules.

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

# Combat transaction rollback — IMPLEMENTED, runtime verification still incomplete

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

User runtime result before the latest damage/critical pass:

**Defence invalidation/reopen is working correctly for the tested case.**

## Damage rollback design/current implementation

Rollback supports the latest applied Damage transaction for an Actor.

Cascade when invalidating a Defence with downstream applied damage is intended to be:

```text
Critical created by that DamagePacket
→ revert/remove exact critical consequence
→ if fatal application exists, revert it too
→ restore Wounds from recorded before/after state
→ mark damage transaction REVERTED with visible information
→ refund defence resource
→ reopen original attack
```

Rollback must not be silent. Chat/notifications should explain what was reverted.

Safety rule: current state must still match the expected post-transaction state; otherwise rollback refuses and asks GM to revert newer dependent transaction first.

A fatal transaction that has already consumed Fate is also protected from lower-level rollback.

**Important:** the newest fatal-status rollback integration and full Defence → Damage → Critical cascade still require the runtime test described at the top of this handoff.

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
- A persistent detailed Critical Wound stores its resolved effect number directly; it must not depend on current client visibility of a managed RollTable to recover its mechanical identity.
- Fatal/death state is a derived consequence owned by the fatal lifecycle; lower-level rollback must reconcile it through that owner rather than manually toggling unrelated status.
- Authoritative combat reconciliation must be single-writer when several connected clients observe the same ChatMessage update.
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

1. Runtime-test the newest Damage/Critical/rollback/adjudication fixes exactly as listed in **Immediate continuation**.
2. Fix only regressions proven by that runtime pass; do not expand the Critical automation surface until the current lifecycle is stable.
3. Runtime-test the initial Career Item assignment/replacement/permanent-lock lifecycle.
4. Audit the Career Item against English + Polish WFRP 1e Core:
   - Career Class;
   - Advance Scheme;
   - Skills;
   - trappings where relevant;
   - Career Exits;
   - Basic vs Advanced Career identity;
   - stable Career references for exits.
5. Implement a native Career data model / sheet contract.
6. Make active Career drive Current Career, Career Class, Advance Scheme and Career Exits.
7. Only then implement paid Career Transfer as a real XP transaction and Career History append.

Do not reintroduce free-text Current Career or manual Career History/Career Exits editing as a temporary shortcut.

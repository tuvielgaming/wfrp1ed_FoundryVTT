# Session Handoff

**Date:** 2026-08-14  
**Purpose:** Single current implementation/architecture checkpoint. Do not create competing progress documents.

## Source of truth

Repository: `tuvielgaming/wfrp1ed_FoundryVTT`  
Branch: `master`

GitHub/current `master` is authoritative. Fetch the exact current file + blob SHA before every write and preserve user commits/visual adjustments.

Latest implementation commit before this handoff save:

```text
681f3ca3956baaa8dcb11850b4767fabbcc800e5
Preserve lifecycle owner while reordering initiative
```

Important recent user-authored visual commit to preserve:

```text
d07a488171e7d58981b55b2fa724b81ee2e42ece
Attack debt marker position fix
```

Other user-authored visual commits already preserved:

```text
84108b417bcae42666182e45292b3efb051fca3f  Player edit togle style update.
308b5fdd996a3683e67da68e096f0eb9c79cc347  Adjust melee wepon table top display
39a9b2bb288e74f5e451fcde9e08780b67806ec6  Crit wound placement
91b3fd95b3d4300b51ef1cd0a45fecff19249892  Small Wound lock marker alignment
```

---

# Immediate continuation — IMPORTANT

The session ended immediately after implementing a substantial Combat Tracker / optional parry-contract correction. **The newest initiative/turn-state and weapon-parry changes are NOT runtime-confirmed yet.**

First action next session should be runtime validation, not more mechanics.

Test this exact Combat Tracker scenario:

```text
Eluvar 9  ← active
Bofat  8
Ork    7
```

Drag active Eluvar to the bottom.

Expected after the latest code:

```text
Bofat
Ork
Eluvar

→ Bofat becomes active immediately
→ Eluvar is still UNFINISHED for this round
→ the round must NOT end
```

Then:

```text
Bofat presses Next Turn → Bofat completed, Ork active
Ork presses Next Turn   → Ork completed, Eluvar active
Eluvar presses Next Turn→ Eluvar completed, only now Next Round
```

Also test moving the active Combatant after all other Combatants have already finished: active/postponed Combatant should retain focus because it is the only unfinished one.

Test drag UX:

- dragging by the portrait should work;
- hovered insertion row should get green outline + before/after marker;
- moving away removes the marker;
- `Przenieś na koniec / Move to end` drop zone should allow easy placement at the bottom;
- initiative order resets to baseline on Next Round.

If this passes, continue to melee hit-location/damage integration.

---

# Core combat conclusions already audited

## Parry / Parowanie — Core/default interpretation

Core text already checked against English + Polish WFRP 1e Core.

- Parry is a WS test.
- Successful Parry reduces the damaging blow by `1d6`; it does not simply turn the attack into a miss.
- A character may attempt at most `A` parries per round.
- Only one Parry attempt against the same individual blow.
- Ordinary Parry loses the next Attack whether the Parry succeeds or fails.
- Shield Parry gives `+20 WS` and loses all following attacks.
- The Core shield text does not explicitly impose a separate one-shield-parry-per-round limit.
- Therefore an `A=2` character may attempt at most 2 total parries in the round; `A=3` at most 3, including repeated Shield parries against different blows.

Default implementation uses bounded future debt when the following Attack cost cannot be paid immediately:

```text
parriesThisRound → permission cap, maximum A
parryDebt        → timing of future Attack loss
```

Debt is capped at permanent `A`; never allow/display/store `parryDebt > A`.

The user's runtime feedback before the optional-rule work: **default parry rules were working as intended**.

## Dodge Blow / Uniki

Audited Core behavior:

- Initiative test;
- success ignores all damage from that blow;
- at most one attempt per combat round;
- only against a blow seen coming;
- hand-to-hand only, not ordinary missile fire;
- does not spend A.

For one incoming blow project decision is mutually exclusive:

```text
Parry OR Dodge OR None
```

No failed Dodge → Parry and no failed Parry → Dodge against the same attack.

---

# Optional parry rule — ROUND CONTRACT, NO DEBT

World setting exists in native Foundry Game Settings under the WFRP system and is localized through `lang/en.json` / `lang/pl.json`.

Relevant modules:

```text
module/settings/WfrpRuleSettings.mjs
module/combat/CombatAttackEconomy.mjs
module/combat/CombatParrySelection.mjs
```

Setting choices conceptually:

```text
Core/default
→ following Attacks + bounded parryDebt

Optional round contract
→ no debt at all
→ tactical costs live entirely inside current round
```

### Optional round contract — current intended mechanics

Permanent Actor `A` is still the maximum **total number of Parry attempts per round**.

There is one current-round offensive Attack pool plus the overall Parry-attempt cap.

Weapon Parry:

```text
requires current-round A >= 1
→ spends 1 current-round A
→ increments parriesThisRound by 1
→ creates NO debt
```

So `A=2`:

```text
start:          A 2/2, parries used 0/2
weapon parry:   A 1/2, parries used 1/2
weapon parry:   A 0/2, parries used 2/2
another parry:  unavailable
```

Shield / Full Defence:

```text
legal only if no offensive attack has been performed this round,
unless Full Defence was already committed earlier in the round

first Shield parry:
→ set offensive A to 0
→ mark shieldDefenceCommitted
→ consume 1 of total parry attempts
→ NO debt

later Shield parries:
→ offensive A remains 0
→ consume remaining total parry attempts
```

Example `A=3`:

```text
Shield #1 → A 0/3, parry attempt 1/3
Shield #2 → A 0/3, parry attempt 2/3
Shield #3 → A 0/3, parry attempt 3/3
Shield #4 → unavailable
```

Mixed example `A=2`:

```text
weapon parry → A 1/2, attempts 1/2
Shield parry → A 0/2, attempts 2/2
```

If the character performs a real offensive attack first, Shield / Full Defence becomes unavailable for the rest of that round. Weapon parries may remain available only while current-round A remains.

All optional-contract state resets on **Next Round**, not Next Turn:

```text
spent/current A          → reset
parriesThisRound         → 0
attacksMadeThisRound     → 0
shieldDefenceCommitted  → false
parryDebt                → 0
```

Debt badge + GM debt notifications are disabled in optional round-contract mode.

Newest weapon-parry-current-A restriction commit:

```text
dc6f4a0be1ba41572714073c00107a524f350c58
Require current Attack for round-contract weapon parry
```

**This exact final version is pending runtime confirmation.**

---

# Combat Tracker initiative postponement — current design

Relevant modules:

```text
module/combat/CombatRoundInitiativeOrder.mjs
module/combat/CombatRoundTurnState.mjs
module/documents/Wfrp1edCombat.mjs
css/combat-tracker-initiative.css
```

Why separate state exists: Foundry `Combat.turn` is an index into the sorted current turn list. Once the GM may reorder initiative during the round, list position alone cannot mean “this Combatant has finished acting.”

New persistent round state on each Combatant:

```text
flags.wfrp1ed.roundTurnState = {
    round,
    completed
}
```

Contract:

- dragging/reordering NEVER marks a Combatant complete;
- only pressing Next Turn for the focused Combatant marks it complete;
- after Next Turn, focus goes to the first unfinished Combatant from the top of the current order;
- if none remain, advance Next Round;
- moving the active Combatant is postponement, not completion;
- moving a non-active Combatant should preserve current focus;
- temporary initiative changes reset to saved baseline before the next round starts.

Foundry lifecycle complication already addressed in latest code: after bulk initiative reordering, numeric `Combat.turn` can point at a new row while `combat.current.combatantId` still identifies the lifecycle owner. Current code synchronizes the previous lifecycle owner to its new numeric index before transferring focus.

Latest related commits:

```text
a4007946  Track completed turns independently of initiative order
6c6ff906  Advance combat by unfinished round turns
5f559301  Improve round initiative drag and focus handling
609d718b  Add initiative drag feedback
01fcff10  Load Combat Tracker initiative feedback styles
9c50a262  Synchronize Combat turn history after reorder
681f3ca3  Preserve lifecycle owner while reordering initiative
```

Again: this final lifecycle fix is **not runtime-confirmed yet**.

---

# Real melee attack → defence transaction — IMPLEMENTED

The project has moved beyond the old handoff's query-only defence state.

A successful real melee attack with a defending Actor now owns a real defence transaction on the attack ChatMessage.

Relevant modules include:

```text
module/combat/CombatDefenceTransaction.mjs
module/combat/CombatDefenceResultContext.mjs
module/combat/CombatDefenceOpportunity.mjs
module/combat/CombatDefenceAutoResolution.mjs
module/combat/CombatParrySelection.mjs
module/combat/CombatDodgeEconomy.mjs
module/combat/CombatAttackResultChat.mjs
```

Current defence UX is one compact selector, not three permanent buttons and not a second parry-item dropdown.

It defaults to `No defence` and contains only currently legal options, e.g.:

```text
Brak obrony
Uniki
Parowanie — Topór (+0) — Koszt 1 A
Parowanie — Shield (+20) — [shield cost label]
```

Unavailable Dodge/Parry options are omitted rather than rendered disabled.

If neither Parry nor Dodge is actionable, defence auto-resolves to No defence and explains that the defender has no remaining defence capability instead of forcing a one-option selector.

## Outside Combat Tracker

Attack + defence procedure is intentionally available outside Combat Tracker.

Outside Combat:

- Parry still rolls WS with actual valid held Item;
- Dodge still rolls Initiative and requires Dodge Blow skill;
- no Combatant A/debt/Dodge-per-round state is automatically mutated;
- dropdown still displays rule reminders (`Cost 1 A`, `once per round`, shield Full Defence wording) so users remember manual bookkeeping.

Combat Tracker is an automation layer, not a prerequisite for basic combat procedure.

---

# Targeting UX — IMPLEMENTED

Attack dialog target selection was simplified to **one dropdown**.

Do not restore the previous double-dropdown pattern (`Defender/Object` + separate visible-token selector).

Current attack selector conceptually contains:

```text
Choose target / resolve after roll...
No defender / object
<visible token A>
<visible token B>
...
```

Existing shortcut buttons may update this same target state:

```text
Use current target
Clear target
GM: Choose Actor
```

Pending attack chat target selector was also unified; selecting target does not immediately roll. User confirms with explicit Roll/Rzuć.

Players should not see sidebar-Actor drag/chooser controls they normally cannot use; GM may use Actor chooser.

---

# Chat/Test presentation and visibility — IMPLEMENTED

Test cards use compact portrait-based identity:

```text
[Actor portrait]  Test: <test/action>
                  Target: <target if any>

                  Success / Failure on its own second row
```

For an attack, Test identity uses weapon name, e.g. `Test: Topór` / `Test: 2H Sword`.

For Parry, the parrying Item is deliberately public even to unrelated viewers:

```text
Test: Parowanie — Shield
Test: Parowanie — 2H Sword
```

But restricted viewers do not get numeric defence mechanics.

Default audience policy:

```text
GM
→ full test card

OWNER of Actor making the test
→ full test card

everyone else
→ who / portrait
→ Test/action identity
→ target if any
→ Success/Failure only
```

Hidden from unrelated viewers:

```text
Próg / target number
base characteristic/formula
modifiers
final threshold
d100 value
margin
combat/range diagnostics
```

Defence-specific data/controls are visible only to:

```text
GM
OR defender Actor OWNER
```

Unrelated players do not see the defence transaction section on the attack card.

GM can still use the Test-message visibility override to publish full details.

This is UI/knowledge-boundary hiding, not cryptographic secrecy from someone inspecting synchronized ChatMessage flags in devtools.

---

# Test post-roll adjudication — implemented + runtime-confirmed

General modifier:

- blank / `+` / `-` normalizes to `0` instead of throwing.

Physical/manual d100 result:

```text
GM
OR OWNER of Actor represented by the ChatMessage speaker
```

may edit Roll/Rzut.

Permission follows Actor ownership, not whichever user clicked the original roll. Owner edits of GM-authored ChatMessages route through active GM socket. Recalculation uses persisted Test snapshot; original Foundry Roll remains preserved for audit/Luck semantics.

---

# Attacks / A sheet status and owner-edit permission — runtime-confirmed foundation

Permanent Actor `A` remains the permanent allowance.

Inside Combat, Combatant owns runtime resource state. Outside Combat, Classic sheet exposes Actor-level manual current A for abstract adjudication; out-of-combat attack rolls do not auto-spend it.

Classic display stays simple:

```text
2/2
1/2
0/2
```

Manual values are clamped to `0..A` with notification.

Shared Actor owner-edit permission controls manually managed fields such as Wounds and A.

Approved icon states at top-right of Classic sheet:

```text
editing OFF → red user-lock
editing ON  → green user-check
```

GM can always adjudicate; non-GM must be Actor OWNER and shared edit permission enabled.

## Default-mode debt reminder

In Core/default debt mode only:

- pending/paid debt is shown as a small badge near A;
- when debt is paid at the new round/turn window, badge remains visible during that Actor's turn so `0/2` is understandable;
- badge clears when that Actor ends their turn;
- GM gets grouped round debt notification;
- user's positioning adjustment `d07a4881` must be preserved.

Optional round-contract mode disables debt presentation entirely.

---

# Existing combat attack foundation — preserve

Equipped melee weapon interaction:

```text
Left click         → attack
Shift + left click → open/edit Item
```

Equipped melee rows use rollable characteristic-style hover feedback.

Combat Tracker is optional for attacking:

- participating Combatant → active-turn/A automation;
- Actor outside/no Combat → attack is still allowed, no automatic A spending.

Attack uses generic WS Test engine. Do not create a second combat d100 implementation.

---

# Ranged attack direction — designed, not end-to-end implemented

Do not force ranged/firearm/spell attacks through melee resolution.

Ordinary ranged:

- BS;
- normal missile fire does not use ordinary Parry/Dodge;
- range modifies BS and damage;
- firearm reload/misfire and thrown ES semantics need exact Core handling;
- mounted/flying/cover/etc. are contextual rules, not separate generic test engines.

Per-attack option already designed/founded:

```text
[✓] Automatically apply range effects
    Distance: [0]
```

Enabled → derive band + BS/damage effects.  
Disabled → no automatic range mechanics; generic modifier + manual damage modifier.

GM must be able to edit Automatic Range Effects/distance after roll and recalculate against the same physical d100.

Ranged execution is still intentionally disabled until Draw/Load/Aim/Fire lifecycle is implemented correctly.

---

# Existing foundations to preserve

## Wounds / damage

- Remaining Wounds stop at zero.
- Overflow becomes `criticalValue`; never negative Wounds storage.
- Immutable `DamagePacket` + `DamageResolver`.
- Explicit Apply Damage from ChatMessage state.
- GM or target Actor OWNER permission.
- double-application protection.

```text
woundsAfter = max(0, woundsBefore - damage)
criticalValue = max(0, damage - woundsBefore)
```

## Detailed Critical / Sudden Death / Fate

Persistent Critical Wound Item and detailed Core critical-table foundation exist. Sudden Death → defeated → GM/OWNER Fate spend is runtime-confirmed. Full detailed-critical flow through a genuine combat hit remains pending until real melee damage is connected.

## Luck / Szczęście

Stable `rulesId=luck`; original physical Roll preserved; existing Luck adjustment/history behavior remains.

## Inventory/equipment

Canonical physical state:

```text
state.mode = carried | held | worn
state.hand = none | right | left | both
```

Page-2 Ekwipunek = master physical inventory. Page-1 weapon/armour tables = combat summaries. Never create a competing inventory architecture.

Resolver APIs:

```text
game.WFRP1ED.equipment.resolver.armourAt(actor, location)
game.WFRP1ED.equipment.resolver.shieldArmour(actor)
game.WFRP1ED.equipment.resolver.parryOptions(actor)
```

---

# Next implementation path after pending runtime test

First inspect CURRENT GitHub, especially:

```text
module/combat/CombatRoundTurnState.mjs
module/combat/CombatRoundInitiativeOrder.mjs
module/documents/Wfrp1edCombat.mjs
module/combat/CombatAttackEconomy.mjs
module/combat/CombatParrySelection.mjs
module/combat/CombatDefenceTransaction.mjs
module/combat/CombatDefenceOpportunity.mjs
module/combat/CombatAttackResultChat.mjs
module/tests/TestResultChat.mjs
```

1. Runtime-confirm newest initiative postponement + unfinished-turn lifecycle.
2. Runtime-confirm final optional round-contract parry semantics:
   - weapon parry requires/spends 1 current A;
   - Shield Full Defence sets current A to 0 but uses remaining parry-attempt cap;
   - no debt anywhere in optional mode;
   - all resets next round.
3. If failures appear, fix those before further combat features.
4. Once confirmed, continue a surviving real melee hit into:

```text
reverse attack d100 → hit location
→ Strength/weapon damage
→ successful Parry 1d6 reduction at correct Core stage
→ Toughness + armour by location
→ existing DamagePacket
→ Apply Damage
→ detailed/Sudden Death critical pipeline
```

5. Runtime-test detailed critical end-to-end through genuine combat damage.
6. Then ranged lifecycle + GM-editable Automatic Range Effects.
7. Later: charge, reload/misfire, surprise, fleeing, mounted/flying, optional Weapon Modifiers, spells/magic.

---

# Persistent cautions / open work

- User Foundry runtime validation is definitive.
- Fetch exact current GitHub source + SHA before every edit.
- Preserve user commits/visual adjustments.
- Foundry v14 native APIs/Documents; JavaScript only.
- Verify Core mechanics before encoding new rules; English mechanics / Polish terminology.
- Optional shield round contract is a project-configurable interpretation, not silently asserted as the only RAW reading.
- Never auto-select weapon vs Shield for Parry.
- In default/Core mode keep bounded `parryDebt`; in optional round-contract mode debt must remain zero and invisible.
- Preserve original physical rolls before post-roll adjudication/Luck.
- Resolve token/synthetic Actor before world prototype where appropriate.
- Stable IDs/flags, not localized names, for mechanical identity.
- `RULEBOOK_IMPLEMENTATION.md` is stale status documentation; update that existing file at a stable combat checkpoint rather than creating another status document.

Open work after immediate validation:

1. Melee defence → hit location → damage → DamagePacket.
2. Successful Parry `1d6` damage reduction integrated at correct stage.
3. Real-combat detailed critical end-to-end test.
4. Ranged lifecycle/range automation.
5. Firearm/thrown special rules after exact Core audit.
6. Mounted/flying/special combat context.
7. Spell/magic combat.
8. Detailed Critical consequence/ActiveEffect contracts/recovery.
9. Standalone Upadek and actual drop-held-items.
10. Fate internal `{value,max}` cleanup/migration.
11. Whole Classic sheet scroll reset only if still reproducible.
12. Remaining Actor/Item/classic-sheet MVP sections.

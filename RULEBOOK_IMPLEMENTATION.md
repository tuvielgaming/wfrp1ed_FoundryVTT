# WFRP 1e Rulebook Implementation Audit

**Status:** Active audit  
**Primary mechanics authority:** English *Warhammer Fantasy Roleplay* 1st Edition Core Rulebook  
**Polish terminology authority:** Polish *Warhammer Fantasy Roleplay — Edycja Polska* Core Rulebook  
**Implementation baseline:** Current uploaded repository source

## Audit rules

1. No gameplay implementation is accepted from memory alone.
2. The relevant English rulebook section is verified before changing mechanics or persistent game data.
3. The corresponding Polish section is checked for official Polish terminology and translation differences.
4. The current repository file is inspected before any replacement is produced.
5. A rule is marked **Implemented** only when its complete lifecycle is verified: persistent data, derived data, display context, sheet binding, user action, persistence, and tests where applicable.
6. A rulebook statement is not converted into automation unless the rule actually requires or clearly permits that automation.
7. If the English and Polish editions differ mechanically, the English edition controls mechanics and the difference is documented.

---

# Section 1 — Characteristics

## Sources verified

### English Core Rulebook

- **The Players' Section — Characteristics**, printed page 13.
- **The Profile / Creating the Character Profile**, printed page 14.
- **Advance Scheme / The Free Advance**, printed page 19.

### Polish Core Rulebook

- **Podręcznik Gracza — Cechy**, printed page 13.
- **Charakterystyka / Tworzenie bohatera**, printed page 14.
- **Schemat rozwoju / Wolne rozwinięcie**, printed page 19.

## Canonical characteristic profile

The core profile contains fourteen characteristics in this order:

| Canonical key | English | English abbreviation | Polish | Polish abbreviation | Scale |
|---|---|---:|---|---:|---|
| `m` | Movement | M | Szybkość | Sz | integer |
| `ws` | Weapon Skill | WS | Walka Wręcz | WW | percentage |
| `bs` | Ballistic Skill | BS | Umiejętności Strzeleckie | US | percentage |
| `s` | Strength | S | Siła | S | integer |
| `t` | Toughness | T | Wytrzymałość | Wt | integer |
| `w` | Wounds | W | Żywotność | Żyw | integer |
| `i` | Initiative | I | Inicjatywa | I | percentage |
| `a` | Attacks | A | Atak | A | integer |
| `dex` | Dexterity | Dex | Zręczność | Zr | percentage |
| `ld` | Leadership | Ld | Cechy Przywódcze | CP | percentage |
| `int` | Intelligence | Int | Inteligencja | Int | percentage |
| `cl` | Cool | Cl | Opanowanie | Op | percentage |
| `wp` | Will Power | WP | Siła Woli | SW | percentage |
| `fel` | Fellowship | Fel | Ogłada | Ogd | percentage |

The internal key should remain language-neutral and follow the English canonical abbreviation where practical. Localization determines the displayed abbreviation. Therefore the canonical internal movement key should be `m`, while the Polish sheet displays `Sz`.

## Advancement units

The rulebook distinguishes the characteristic profile from the career Advance Scheme.

- Movement, Strength, Toughness, Wounds, and Attacks advance in steps of **1**.
- Weapon Skill, Ballistic Skill, Initiative, Dexterity, Leadership, Intelligence, Cool, Will Power, and Fellowship advance in steps of **10**.
- The free advance follows the same unit distinction: +1 for the integer group or +10 for the percentage group.

A data model may store advancement as a count of acquired steps, but the meaning must be explicit and consistently named. Derived current profile values must be calculated in exactly one place.

## Persistent versus derived data

### Persistent

For each characteristic, the minimum required persistent concepts are:

- starting or initial profile value;
- number/value of advances actually taken;
- maximum advances available from the active career scheme, if the sheet is expected to display the scheme.

### Derived

- current profile value;
- formatted advance value shown on the sheet;
- whether another advance may be purchased from the active career.

Derived values must not be duplicated as independent persistent values.

## Current repository comparison

### Confirmed correct direction

- `initial`, `purchased`, `career`, and `advanceStep` can represent the three rows of the original character sheet when their meanings are made explicit.
- `prepareDerivedData()` is the correct Foundry lifecycle location for the current profile calculation.
- The 1-versus-10 `advanceStep` distinction matches the core rules.

### Confirmed discrepancies

1. **Movement key mismatch**
   - Current key: `sp`.
   - Canonical internal key should be `m`.
   - Polish display abbreviation should come from localization as `Sz`, not from the persistent key.

2. **Prototype default character data**
   - Several characteristics contain non-zero sample `purchased` and `career` values.
   - A newly created Actor must not silently begin with a sample career or purchased advances.
   - Schema defaults should be neutral; character generation or compendium content supplies actual starting values.

3. **Derived property mismatch**
   - `Wfrp1edActor.prepareDerivedData()` writes `characteristic.current`.
   - `TestResolver` and `FormulaResolver` read `characteristic.actual`.
   - One canonical derived property must be selected and used by every consumer.
   - Current project direction already uses the word `current` on the original-sheet presentation, so `current` is the leading canonical candidate, but the final change must be made across all dependent files in dependency order.

4. **Ambiguous advancement field names**
   - `purchased` appears to mean the number of advance steps taken.
   - `career` appears to mean the number of advance steps available in the active career scheme.
   - These meanings must be documented and enforced. A future rename may improve clarity, but renaming is not required until all consumers are audited.

5. **Current Wounds tracking is unresolved**
   - Wounds is part of the profile and represents the amount of damage that can be endured before serious injury.
   - The combat chapter must be verified before choosing the persistent structure for current damage/current Wounds.
   - The profile maximum and in-play wound state must not be conflated accidentally.

## Required implementation sequence

The Characteristics subsystem must be repaired in this order:

1. `template.json`
   - neutral characteristic defaults;
   - canonical `m` key;
   - retain one explicit advancement representation.
2. `module/documents/Wfrp1edActor.mjs`
   - one derived `current` calculation;
   - safe handling of Actor types without a characteristic profile.
3. `module/tests/TestResolver.mjs`
   - consume the canonical derived property.
4. `module/tests/FormulaResolver.mjs`
   - consume the same property and include Movement only where formulas need it.
5. Display builders and sheets
   - use localized labels/abbreviations;
   - never recalculate the current profile in HBS.
6. Migration
   - existing Actors using `sp` require an explicit migration to `m` before a release containing this schema change.

## Status

| Area | Status |
|---|---|
| Rulebook verification | Verified |
| Polish terminology comparison | Verified |
| Current schema audit | Verified |
| Code changes | Not started |
| Migration design | Required |
| Runtime test in Foundry v14 | Required |

---

# Section 2 — Character Status and Campaign Resources

## Sources verified

### English Core Rulebook

- **The Players' Section — Fate**, printed pages 15–16.
- **The Gamesmaster — Fate Points**, printed page 72.
- **The Gamesmaster — Character Advancement and Experience / Experience Points / Spending Experience Points**, printed pages 90–91.
- **Combat — Wounds and Recovery**, printed pages 129–130.

### Polish Core Rulebook

- **Podręcznik Gracza — Przeznaczenie**, printed pages 15–16.
- **Mistrz Gry — Punkty Przeznaczenia**, printed page 72.
- **Mistrz Gry — Rozwój bohatera i doświadczenie / Punkty doświadczenia / Wydawanie punktów doświadczenia**, printed pages 90–91.
- **Walka — Rany i rekonwalescencja**, printed pages 129–130.

## Fate Points

The core rules define **Fate Points** as a finite character resource. They are generated during character creation, may occasionally be gained or lost through divine action, and are permanently expended to save a character from certain death. Spent Fate Points are not automatically recovered.

The official Polish term is **Punkty Przeznaczenia**.

### Data-model consequences

The minimum persistent concepts are:

- original or maximum Fate Points, so the character's generated value is not lost;
- currently unspent Fate Points.

A single scalar `fate.value` cannot preserve both concepts after points are spent. The Character schema therefore needs an explicit maximum/current pair or an equivalent non-redundant representation.

### Confirmed discrepancy: Fortune

The current Character schema contains both `fate` and `fortune`. The WFRP 1e core rules verified above define Fate Points but do not define a replenishing Fortune Point resource. `fortune` is therefore not part of the WFRP 1e core Character model and must be removed unless a later, explicitly optional supplement requires it.

## Wounds and in-play damage

Wounds is one of the fourteen profile characteristics. It represents a buffer of damage a creature can endure before serious damage occurs. Damage reduces remaining Wounds; critical damage becomes relevant after that buffer is reduced below zero. The recovery rules classify wounded characters according to remaining Wounds and critical injuries.

The official Polish profile term is **Żywotność**, while the recovery section uses the language of wounds and injuries (**rany**, **obrażenia**, **Rany i rekonwalescencja**).

### Data-model consequences

The system must distinguish:

- the derived current **Wounds characteristic maximum** from the profile;
- the persistent **remaining Wounds** during play, or an equivalent persistent damage value from which remaining Wounds is derived;
- critical injuries, which cannot be represented by a simple negative number alone once the full combat subsystem is implemented.

The current schema has only the profile characteristic `w` and no verified in-play wound state. This is incomplete for a campaign-ready Character Actor.

The canonical representation is not selected yet. Before replacing the schema, the Classic sheet's exact fields and the combat/critical-injury lifecycle must be audited. Whichever representation is selected must have one calculation owner and must not persist both damage and remaining Wounds independently.

## Experience Points

Experience Points are awarded by the GM and are then spent to purchase characteristic advances and new skills. The rules treat unspent EP as a spendable resource and also describe character growth over the campaign.

The official Polish term is **Punkty Doświadczenia**.

### Data-model consequences

The minimum persistent concepts are:

- total Experience Points awarded over the character's history;
- Experience Points spent.

Available Experience Points should be derived as:

```text
available = totalAwarded - spent
```

An alternative current-plus-spent representation is possible, but the project must not persist three independently editable values that can contradict one another.

An audit log may be useful for production traceability, but it is not itself a core-rule field and must not be required for the basic rule calculation. If retained, it should record transactions from which totals can be checked rather than act as a second calculation source.

### Current repository discrepancy

The current `experience` object contains `value`, `total`, `spent`, and `log`. The meaning of `value` is undefined and can conflict with `total - spent`. One canonical pair plus one derived value must replace this ambiguous structure.

## Current repository comparison

### Confirmed correct direction

- Fate belongs to Character status rather than an Item.
- Experience belongs to the Character and must persist across careers.
- The Wounds profile maximum belongs to the characteristic profile and must remain derived from the starting profile plus advances.

### Confirmed discrepancies

1. `fortune` is not a WFRP 1e core resource.
2. `fate.value` alone cannot preserve generated maximum and currently unspent Fate Points.
3. No in-play remaining-Wounds or damage state is defined.
4. `experience.value`, `experience.total`, and `experience.spent` create an ambiguous, potentially contradictory model.
5. `system.json` currently points token bars to `health` and `power`, neither of which exists in the current Actor schema. The token-bar decision must wait until the wound and magic-resource models are verified.

## Required implementation sequence

1. Audit the original Polish Classic sheet fields for Fate, Wounds, critical injuries, and Experience.
2. Verify critical-hit and recovery persistence requirements from the combat chapter.
3. Select one non-redundant Wounds/damage representation.
4. Replace the Character status and Experience structures in `template.json`.
5. Update `Wfrp1edActor.prepareDerivedData()` to derive Wounds maximum and available Experience in one place.
6. Update sheet context, HBS bindings, token attributes, and actions.
7. Add migration handling for existing Actors.

## Status

| Area | Status |
|---|---|
| Fate rule verification | Verified |
| Polish Fate terminology | Verified |
| Fortune core-rule status | Verified absent from core |
| Experience rule verification | Verified |
| Wounds/recovery rule verification | Partially verified; critical lifecycle still required |
| Current schema audit | Verified |
| Code changes | Not started |
| Migration design | Required |
| Runtime test in Foundry v14 | Required |

---

# Section 3 — Movement Procedures: Zeskok, Upadek, Skok

## Sources verified

### English Core Rulebook

- **The Gamesmaster — Jumping, Falling, Leaping, Climbing**, printed page 75.
- **The Gamesmaster — Standard Tests**, printed page 66, where Fall, Jump, and Leap refer to Movement and Acrobatics.

### Polish Core Rulebook

- **Mistrz Gry — Zeskok, Upadek, Skok, Wspinaczka**, printed page 75.

The editions agree mechanically on the audited procedures. The Polish edition uses metric equivalents and provides the official terminology mapping:

| English procedure | Polish procedure | Meaning |
|---|---|---|
| Jumping | Zeskok | controlled vertical descent |
| Falling | Upadek | uncontrolled vertical descent |
| Leaping | Skok | horizontal jump |

This distinction is canonical for the system. `Zeskok` must not be presented as `Skok`, and a failed horizontal `Skok` leads to an `Upadek`, not another `Zeskok`.

## Zeskok / Jumping

Zeskok is a deliberate, controlled descent in which the character expects to land on their feet. An accidental descent or a character being pushed is an Upadek instead.

Mechanical procedure:

1. Determine vertical distance.
2. Round the distance **up** to the next whole yard/metre.
3. Roll `1d6`.
4. Acrobatics contributes `+2` to that die result.
5. Subtract the effective die result from the rounded distance.
6. If the result is zero or less, no Wounds are suffered.
7. A positive result is the number of Wounds suffered.
8. These Wounds ignore both Armour and Toughness modifiers.
9. If any Wounds are suffered, there is a 50% chance the character drops everything held.
10. The procedure occupies a full round.

Canonical calculation:

```text
zeskokDamage = max(0, ceil(height) - (1d6 + reductionDieBonuses))
```

The system does not hardcode Acrobatics by Item name. Its audited +2 contribution is represented through the stable Active Effect target:

```text
procedure.movement.jump.reductionDie
```

## Upadek / Falling

Upadek is uncontrolled descent. It uses the same damage procedure as Zeskok except the fall distance is treated as **double** before the d6 reduction is applied.

Acrobatics again contributes `+2` to the d6 result, and suffering Wounds again causes the 50% held-item drop check.

Canonical calculation:

```text
fallDamage = max(0, 2 * ceil(height) - (1d6 + reductionDieBonuses))
```

A standalone Upadek procedure is not yet exposed by the system. When a horizontal Skok fails, the current implementation correctly leaves the actual fall height to the GM/scene rather than inventing it from the attempted gap distance.

## Skok / Leaping

Skok is a horizontal leap.

With at least two yards/metres of run-up:

```text
distance = max(1, 2 * Movement - 1d6 + leapBonuses)
```

Without sufficient run-up:

```text
distance = max(1, 2 * Movement - 2d6 + leapBonuses)
```

Acrobatics contributes `+2` yards/metres to the achieved leap distance. The system represents this through the stable target:

```text
procedure.movement.leap.distance
```

If the achieved distance is insufficient, the character falls. The actual fall height is situational and must be supplied from the scene/GM before Upadek damage can be resolved.

## Current implementation comparison

`module/tests/MovementStandardTest.mjs` already implements the audited Zeskok and Skok calculations without hardcoding Skill names.

Zeskok now integrates with the generic damage workflow only when it produces positive Wounds:

```text
MovementStandardTest
→ DamagePacket
→ DamageResolver
→ existing movement ChatMessage damage flag
→ explicit Zastosuj obrażenia
→ DamageApplication
```

The packet declares:

```text
Armour: ignore
Toughness: ignore
```

which matches the rulebook. Calculation still does **not** mutate Actor Wounds automatically. The existing movement result card receives the damage state and uses the common GM/target-OWNER application transaction.

No damage packet is attached when Zeskok causes zero Wounds.

## Status

| Area | Status |
|---|---|
| English movement mechanics | Verified |
| Polish terminology/mechanics comparison | Verified |
| Zeskok calculation | Implemented; previously runtime-tested |
| Zeskok generic damage integration | Implemented; Foundry v14 runtime test required |
| Skok calculation | Implemented; previously runtime-tested |
| Failed Skok → situational fall handling | Implemented as GM/scene decision |
| Standalone Upadek procedure | Not implemented |

---

# Next audit section

**Classic-sheet field contract:** inspect the original Polish character-sheet scans and every active overlay binding for Characteristics, Fate, Wounds, Experience, and career advances.

This must be completed before replacing `template.json`, because the production schema has to satisfy both the verified core rules and the exact information recorded by the original sheet.

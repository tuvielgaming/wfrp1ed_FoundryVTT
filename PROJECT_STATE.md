WFRP1ED PROJECT STATE

Version: 3.4
Status: ACTIVE — BASELINE REVERIFICATION
Last Updated: 2026-08-05

===============================================================================
PROJECT VISION
===============================================================================

Develop the most faithful implementation of Warhammer Fantasy Roleplay
1st Edition for Foundry Virtual Tabletop Version 14.

The project is designed exclusively for WFRP 1st Edition.
Compatibility with later editions (2e, 3e, 4e) is not a goal.

Whenever convenience conflicts with authenticity, WFRP 1st Edition wins.

The Classic Character Sheet is intended to be a digital recreation of the
original Games Workshop character sheet.

The original printed sheet is the visual specification.
Foundry provides interaction.
The paper sheet defines layout.

===============================================================================
PRIMARY MVP GOAL
===============================================================================

The MVP is complete when a Game Master can run the first full WFRP 1e campaign
in Polish without relying on paper character sheets and without knowingly
incomplete core records or rule paths.

The MVP is not a prototype. It is the first complete playable release.

The MVP includes:

- Fully functional Polish Classic Character Sheet
- Original Polish WFRP 1e character-sheet scan as the visual background
- All overlays required by the original sheet
- Complete core Actor and Item structures required for campaign play
- Complete Actor and Item sheets required for those structures
- Complete template.json structures and persistent data models
- Characteristics and advances
- Skills, talents and traits required by the core rules
- Careers and career progression
- Equipment, money and encumbrance
- Melee and ranged weapons
- Combat, armour, damage and injury handling
- Wounds, Fate, Fortune and insanity
- Movement
- Experience
- Core magic and spells required for campaign play
- Standard tests and core rolls
- Embedded Item creation, editing, display and use
- Chat output
- Polish localization
- Safe rendering of new and partially completed Documents
- Correct persistence after closing and reopening sheets

Nothing required to represent or operate the above core systems may be left as a
placeholder or knowingly postponed merely to shorten the MVP.

Not required for this MVP:

- Alternative Modern Character Sheet
- English or other localized Classic Sheet scans
- Visual Layout Editor
- Supplement-specific rules or fields
- Optional convenience automation that is not required for core play
- Advanced GM tools
- Complete published-content compendia containing every career, spell,
  creature or item, provided the core models and sheets can represent them

===============================================================================
CLASSIC SHEET PHILOSOPHY
===============================================================================

The Classic Character Sheet should feel like using the original paper sheet.

Goals:

- Original proportions
- Original section layout
- Original terminology
- Original typography where practical
- Pixel-accurate alignment
- Original artwork
- Functional Foundry interaction without redesigning the sheet

The sheet uses fixed dimensions matching the original artwork.
It is not a modern responsive dashboard.

Interactive controls are overlaid on the scan and should not unnecessarily
change the appearance of the original sheet.

===============================================================================
POLISH-FIRST CLASSIC SHEET DECISION
===============================================================================

The first supported Classic Character Sheet localization is Polish.

The Polish scan is the initial background and alignment reference.
The Classic sheet uses a fixed internal canvas with interactive HTML controls
overlaid on the scan.

Different localized scans may contain small pixel shifts. Therefore:

- ThemeManager selects localization-specific backgrounds and visual assets
- LayoutManager provides localization-specific coordinates and dimensions
- Polish coordinates are implemented first
- Other localizations may provide their own background and coordinate map later
- Localization differences must not require changes to Actor rules,
  DisplayBuilder calculations or shared Handlebars structure

The Classic sheet is the preferred and primary MVP sheet.
A Modern sheet is a future optional presentation layer and must not delay the
Polish Classic MVP.

===============================================================================
RULEBOOK REFERENCE POLICY
===============================================================================

The official rulebooks are the functional specification for game mechanics.
They are not optional background reading.

Canonical reference order:

1. English WFRP 1e Core Rulebook
   - Primary authority for mechanics, procedures, formulas and rule intent

2. Polish WFRP 1e Core Rulebook
   - Primary authority for official Polish terminology and localization
   - Compared against the English edition when implementing mechanics

3. Original Polish Character Sheet
   - Primary authority for Classic-sheet layout, labels and visual organization

If the English and Polish editions differ:

- Mechanics follow the English edition
- Polish UI terminology follows the Polish edition when it does not alter rules
- Significant differences must be documented explicitly
- The difference must not be silently reconciled

The assistant must not claim that either rulebook has been completely read or
remembered. The relevant sections must be consulted when implementing or
reviewing a mechanic.

For every change that affects WFRP mechanics:

- Both rulebooks must be available in the current working context, normally by
  uploading the current repository ZIP containing both PDFs
- The relevant English section must be checked first
- The corresponding Polish section must be checked for terminology and possible
  translation differences
- The returned change must identify the chapters/pages used for verification
- No mechanic may be implemented from memory, later editions or fan summaries

Supplement rules are outside the current core MVP.
They may be added later as optional compendia and switchable rule packages.
Supplement-specific fields must not be invented before the relevant supplement
is actually analyzed.

===============================================================================
LANGUAGE AND TECHNOLOGY DECISION
===============================================================================

Implementation language:

- JavaScript only
- ES modules where appropriate
- No TypeScript
- No TypeScript migration or TypeScript-specific build tooling unless the user
  explicitly changes this decision in the future

Platform and presentation:

- Foundry VTT Version 14
- Native V14 APIs and patterns
- Handlebars templates
- CSS
- JSON localization files

===============================================================================
PRODUCTION DEVELOPMENT PRINCIPLES
===============================================================================

This project is handled as a production project.

Mandatory principles:

- No placeholders in core MVP functionality
- No ad hoc fixes that preserve incompatible architectures
- No mixed legacy and new patterns without an explicit migration decision
- One source of truth for every persistent value
- One owner for every derived calculation
- One documented template-context contract
- No calculations in Handlebars templates
- No formatted display values stored in persistent system data
- No speculative supplement fields
- Readability over cleverness
- Small dependency-ordered changes
- Verify before modifying
- Ask when context is missing
- Never assume

A feature is complete only when its full lifecycle is complete:

Rulebook requirement
-> data model
-> persistent Document data
-> derived calculation, when required
-> display preparation
-> template rendering
-> user edit or action
-> correct Document update
-> correct value after reopening the sheet
-> localization
-> verification/testing

===============================================================================
SOURCE-FIRST DEVELOPMENT RULE
===============================================================================

This is a non-negotiable project rule.

The current uploaded repository files are the only implementation source of
truth.

Required behavior:

- Inspect the actual current file before making claims about its contents
- Never reconstruct current code from memory, previous conversations, old ZIPs
  or generic Foundry examples
- Never claim a previous fix is present until it is verified in the current
  uploaded source
- Never silently combine different revisions of a file
- If a required file is unavailable, ask the user for that exact file
- If a change spans many dependencies, ask for the latest full repository ZIP
- If a change affects WFRP mechanics, ask for the current repository ZIP that
  contains both official core rulebooks
- If sources conflict, stop and identify the conflict

Every technical statement must be classified mentally as one of:

FACT
Directly verified in the current uploaded project files.

RULEBOOK VERIFICATION
Verified against the relevant English and Polish core-rulebook sections.

API VERIFICATION
Verified against Foundry VTT Version 14 documentation.

INFERENCE
Reasoning based on verified facts.

PROPOSAL
A possible change that has not yet been approved or implemented.

Inference and proposals must never be presented as repository facts.

===============================================================================
OFFICIAL FILE-BY-FILE WORKFLOW
===============================================================================

The default workflow for focused or high-risk work is one file per response.

1. The assistant identifies the next dependency and asks for one exact current
   repository file using its full project-relative path.

2. The user uploads that current file.

3. The uploaded file becomes the only source of truth for that file.

4. Before changing it, the assistant checks whether another dependency must be
   reviewed first.

5. If another dependency is required, the assistant stops and asks for that
   dependency instead of guessing.

6. If changes are required, the assistant returns exactly one complete
   replacement file in the response.

7. The assistant states the exact project-relative path where the file belongs.

8. The user replaces the file in the local repository.

9. The assistant then asks for the next dependency.

Rules for returned files:

- Return the complete file, never partial methods or fragments
- Do not require the user to manually merge snippets
- Do not include unrelated file changes
- One response contains at most one replacement file
- The returned file must be ready to overwrite the repository version
- If no change is needed, say so and do not manufacture a replacement

Broad-work exception:

For repository-wide audits, architecture reconstruction or changes spanning many
unknown dependencies, request the latest full repository ZIP first.

The full ZIP is used for inspection and dependency discovery. Because repository
ZIPs containing both rulebooks may exceed download limits, implementation changes
are still returned one complete file at a time.

Old audit or milestone ZIPs are historical references only.
They must never be blindly overlaid onto the current repository.
They may be inspected selectively after a fresh baseline audit to recover a
specific verified change.

===============================================================================
AUDIT AND IMPLEMENTATION WORKFLOW
===============================================================================

A fresh audit must be based on the current uploaded repository, not previous
audit memory.

Audit order:

1. Repository structure and source-of-truth documents
2. system.json and Foundry V14 registration
3. template.json Actor and Item data structures
4. Actor and Item Document classes
5. Derived-data ownership
6. DisplayBuilder and presentation ownership
7. ActorSheetV2 and ItemSheetV2 context preparation
8. Handlebars paths and partial registration
9. ThemeManager and LayoutManager
10. Polish Classic overlay CSS and artwork dimensions
11. Form submission and persistence
12. Embedded Item lifecycle
13. Test, combat, damage, armour and magic actions
14. Localization
15. Rulebook traceability
16. Static validation
17. Live Foundry V14 validation performed by the user where this environment
    cannot run Foundry

Each finding must be classified:

KEEP
Correct and consistent with the approved architecture.

REFACTOR
The behavior is useful but the implementation conflicts with the canonical
architecture.

REMOVE
Legacy, duplicate, obsolete or invalid implementation.

QUESTION
Insufficient evidence; requires a file, rulebook section, API verification or
user decision.

No source file should be changed merely because an earlier audit claimed it was
broken. The current file must be inspected again.

===============================================================================
CANONICAL ARCHITECTURE DIRECTION
===============================================================================

Rulebook mechanics
-> Actor / Item ownership
-> prepareDerivedData()
-> DisplayBuilder
-> sheet _prepareContext()
-> Handlebars
-> CSS / localized layout
-> user action
-> Document update

Responsibilities:

ACTOR / ITEM DOCUMENTS
- Own persistent game data
- Own game mechanics appropriate to that Document
- Own derived values through Foundry preparation lifecycle
- Never format UI text

prepareDerivedData()
- Produces derived mechanical values only
- Does not format presentation

DisplayBuilder
- Produces localized and formatted presentation data
- Does not perform game-rule calculations
- Does not mutate persistent data

_prepareContext()
- Assembles verified context only
- Does not calculate mechanics
- Does not duplicate formatting

Handlebars
- Renders prepared data
- Uses minimal conditional logic
- Does not calculate mechanics

ThemeManager
- Selects localization-specific artwork and visual assets

LayoutManager
- Supplies localization-specific coordinates and dimensions
- Prevents pixel differences between scans from leaking into shared templates

Data contract:

- system.* contains persistent editable data
- display.* contains read-only formatted or presentation data
- derived mechanical values follow one documented ownership rule
- system.display is not a canonical path
- accidental root aliases are not canonical

===============================================================================
CURRENT VERIFIED STATUS
===============================================================================

The repository is undergoing fresh baseline reverification.

Previous statements that subsystems were stable, frozen or 100% complete are not
currently trusted until confirmed against the uploaded source, the official
rulebooks and Foundry V14.

Therefore, no subsystem is currently marked frozen by this document.

Verified baseline facts from the uploaded pre-audit repository:

- The repository targets Foundry VTT v14
- The codebase uses JavaScript and MJS modules
- Both English and Polish WFRP 1e core rulebooks are stored in the repository
- Polish Classic character-sheet scan assets are stored in the repository
- PROJECT_STATE.md, README.md and FOUNDRY_V14_GUIDELINES.md exist

All implementation-completeness percentages and earlier audit conclusions must be
re-established from scratch.

===============================================================================
CURRENT MILESTONE
===============================================================================

Freshly audit the current pre-audit repository and establish a verified backlog
for the complete Polish Classic MVP.

No gameplay source change should be applied until the relevant dependency chain
has been verified.

After the fresh audit:

- Compare historical audit ZIPs only for specific recoverable work
- Migrate only changes that remain correct under the current architecture,
  rulebook verification policy and Foundry V14
- Return every implementation change one complete file at a time

===============================================================================
ASSISTANT CONTRACT
===============================================================================

When assisting with this project, the assistant must:

- Follow this document
- Use the current uploaded source as implementation truth
- Ask for missing files instead of reconstructing them
- Ask for the repository ZIP with both rulebooks before mechanics work
- Verify English mechanics and Polish terminology before implementing rules
- Use JavaScript only
- Return one complete replacement file per response
- Include the exact project-relative placement path
- Stop when a required dependency has not been verified
- Avoid placeholders and temporary architecture patches
- Distinguish facts, verification, inference and proposals
- Avoid claiming live Foundry validation when it has not occurred
- Never claim a subsystem is complete solely because static files parse
- Never blindly merge old audit snapshots
- Preserve the Polish Classic sheet as the primary MVP presentation

===============================================================================
SOURCE OF TRUTH PRIORITY
===============================================================================

For implementation state:

1. Current uploaded repository files
2. This PROJECT_STATE.md
3. Explicit current user decisions
4. Verified Foundry VTT v14 documentation
5. Historical audit files, only as selective reference
6. General model knowledge

For WFRP mechanics:

1. English WFRP 1e Core Rulebook
2. Polish WFRP 1e Core Rulebook for localization and comparison
3. Explicit documented project decisions
4. No unofficial source unless the user explicitly approves it for a limited
   purpose

For Classic-sheet presentation:

1. Original Polish character sheet and scan
2. Polish core-rulebook terminology
3. Approved ThemeManager and LayoutManager architecture

===============================================================================
NEXT STEP
===============================================================================

Create a fresh BASELINE_AUDIT.md from the current uploaded pre-audit repository.

The audit must begin with repository registration, template.json, Actor and Item
classes, and current sheet registration.

Do not reuse implementation conclusions from earlier audit ZIPs unless the same
finding is independently verified in the current source.

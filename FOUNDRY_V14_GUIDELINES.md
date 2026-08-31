# FOUNDRY_V14_GUIDELINES.md

Version: 1.4
Status: ACTIVE
Last Updated: 2026-08-31

===============================================================================
PURPOSE
===============================================================================

This document defines the coding standards for the WFRP1ED system when using
Foundry Virtual Tabletop Version 14.

It complements PROJECT_STATE.md.

PROJECT_STATE defines WHAT the project is.

FOUNDRY_V14_GUIDELINES defines HOW the code should be written.

Whenever possible, prefer native Foundry V14 APIs and design patterns.

Avoid carrying legacy ActorSheet architecture into new code.

===============================================================================
GENERAL PRINCIPLES
===============================================================================

✔ Use native V14 APIs

✔ Keep Documents as the source of truth

✔ Separate game logic from presentation

✔ Keep Applications lightweight

✔ Never calculate inside templates

✔ Never manipulate DOM directly unless absolutely necessary

===============================================================================
DOCUMENT MODEL
===============================================================================

Documents own game data.

Examples

Actor

Item

JournalEntry

Scene

Applications display Documents.

Applications do not own game state.

Prefer

this.document

instead of

this.actor

unless compatibility requires otherwise.

===============================================================================
APPLICATION LIFECYCLE
===============================================================================

Rendering flow

Document

↓

prepareDerivedData()

↓

DisplayBuilder

↓

_prepareContext()

↓

HandlebarsApplication

↓

Templates

↓

CSS

Applications assemble context.

Applications should not perform game calculations.

===============================================================================
PREPAREDERIVEDDATA
===============================================================================

prepareDerivedData() is responsible for derived game values.

Examples

current characteristics

movement

encumbrance

combat modifiers

derived statistics

Never format values.

Never localize text.

Never prepare UI.

===============================================================================
DISPLAYBUILDER
===============================================================================

DisplayBuilder converts game data into presentation data.

Examples

+30

●●●○○

localized labels

formatted text

grouped collections

DisplayBuilder never changes the Actor.

DisplayBuilder never performs game calculations.

DisplayBuilder returns read-only display data.

===============================================================================
PREPARECONTEXT
===============================================================================

_prepareContext() assembles template context.

Typical responsibilities

Expose actor.system

Expose display.*

Expose CONFIG

Expose theme assets

Expose application state

_prepareContext() should contain little or no business logic.

===============================================================================
HANDLEBARS TEMPLATES
===============================================================================

Templates render data.

Templates should contain minimal logic.

Avoid

mathematics

condition chains

sorting

formatting

data manipulation

If a template requires complicated logic,
move it into DisplayBuilder.

===============================================================================
DATA ORGANIZATION
===============================================================================

Editable values

↓

system.*

Presentation values

↓

display.*

Configuration

↓

CONFIG.*

Theme assets

↓

ThemeManager

Never mix presentation into system.*

===============================================================================
RULE IDENTITY, RULE BINDINGS AND ACTIVE EFFECTS — HARD CONVENTION
===============================================================================

Stable identity and mechanical effects are different concerns and MUST NOT be
combined into one generic "Rules ID" concept.

Ask three separate questions for every Item type.

1. Does this Item need a stable language-neutral content/rules identity?

If NO:

- Do not add a generic `rulesId` merely because the Item represents Core content.
- Prefer explicit structured fields which describe the actual rules facts.

Examples already following this pattern include Equipment and Critical Wounds.
Armour pieces and Weapons should also prefer their structured mechanical fields
instead of an otherwise-unused generic `rulesId`.

If YES:

- The identity must be independent from localized/user-editable `Item.name`.
- It may be stored as `system.rulesId` or another domain-specific canonical key.
- References, duplicate detection and compendium interoperability may use it.
- A UUID identifies one Document instance; a stable rules/content identity may
  identify equivalent content across localized packs and copied Documents.

2. Does the engine need the identity to select special executable behaviour?

If YES:

- Expose a controlled, localized "rules binding" selector.
- Store a canonical language-neutral key internally.
- Never make ordinary users type arbitrary implementation strings.
- The selectable values must come from an audited registry/provider owned by the
  subsystem which executes that rule.

Examples: Skills and Spells; Race may expose controlled Core identity/binding
where creation rules require it.

If NO, but stable identity is still useful:

- Keep the identity internal metadata.
- Do not expose the raw key as an ordinary authoring textbox.
- User-created/homebrew Items may leave it blank unless a stable key is genuinely
  required.
- Core/system compendium build tooling may assign canonical identities.

Examples: Language, Psychology, Disease and future Disorder/health content.

3. Does the Item cause mechanical consequences?

Mechanical consequences should normally be authored as native Foundry
ActiveEffects plus WFRP1ED Rule Effects when those primitives can express the
rule. The Item remains the reusable identity/content owner; its ActiveEffects
represent mechanical consequences.

Use Item-specific structured data for facts and lifecycle state which are not
Active Effects, for example Disease exposure, incubation, duration, diagnosis,
or other audited state-machine data.

Use a dedicated audited procedure provider only when the rule cannot be
expressed declaratively through structured Item data and Active/Rule Effects.
Such a provider is selected by a controlled rules binding, never by comparing a
localized Item name.

Canonical relationship:

Item identity/content
+
Item-specific structured rules/state where required
+
Item-owned ActiveEffects / WFRP Rule Effects
+
controlled procedure binding only for genuinely procedural exceptions

Do NOT:

- hard-code mechanics against localized Item names;
- use a generic `rulesId` as a substitute for proper structured rule data;
- use ActiveEffects as the identity of an Item;
- expose internal canonical IDs as ordinary free-text fields merely for
  convenience;
- give every Core Item a rules identifier when no consumer requires one.

When reviewing an existing `rulesId`, `...Id`, "Rules ID", "Rule identifier",
or "Rules binding" field, classify its role explicitly as one of:

- stable content identity;
- controlled procedure/rules binding;
- domain compatibility key/reference;
- legacy/redundant field to remove.

Fields with different roles must not be treated as interchangeable simply
because their names contain `Id`.

===============================================================================
THEMEMANAGER
===============================================================================

ThemeManager owns visual assets.

Examples

background images

logos

localized artwork

theme metadata

Templates should never reference image files directly.

Applications request assets from ThemeManager.

===============================================================================
EVENTS
===============================================================================

Use V14 actions.

Example

data-action="rollCharacteristic"

↓

DEFAULT_OPTIONS.actions

Avoid legacy activateListeners()
for new functionality.

===============================================================================
APPLICATIONV2 FORM PERSISTENCE — HARD CONVENTION
===============================================================================

Foundry V14 ApplicationV2 forms with `submitOnChange: true` can conflict with
controls which also implement their own explicit persistence.

The failure mode already encountered in this project is:

named input changes
→ ApplicationV2 generic form submit runs
+ custom `change` listener also runs
→ two update paths race or submit overlapping nested data
→ rerender can restore the previous Document value or replace untouched siblings

This was solved previously in Career authoring by disabling generic
submit-on-change and persisting exact field paths, and is also avoided by the
working Experience controls because explicitly persisted controls do not carry a
`name` attribute.

Hard rule:

- A control is owned by exactly one persistence path.
- If the surrounding ApplicationV2 form uses generic `submitOnChange`, a control
  with its own explicit `Document.update()` handler must NOT also participate in
  generic form submission.
- For an explicitly persisted control inside such a form, omit the `name`
  attribute and use a dedicated `data-wfrp-*` selector, then persist the exact
  canonical Document path in the integration.
- If an entire sheet requires safe explicit persistence because nested arrays or
  SchemaFields make generic submission unsafe, set `submitOnChange = false` for
  that sheet and persist exact flat paths explicitly, as done by Career authoring.
- Do not try to solve this race only with `stopPropagation()` on the input's
  `change` event. Foundry's form handling may already own an earlier listener in
  the event path; removing the control from the generic form contract is the
  reliable boundary.
- Do not store edited UI values in application-local state as a substitute for
  Document persistence.

Canonical working references:

module/careers/CareerItemAuthoringIntegration.mjs
module/experience/ExperienceSheetIntegration.mjs
module/fate/FateSheetIntegration.mjs

When an input appears editable but resets when it loses focus, inspect this
persistence ownership rule before adding new event handlers or schema guards.

===============================================================================
PARTS
===============================================================================

Use PARTS to organize complex applications.

Typical examples

header

characteristics

combat

skills

equipment

notes

footer

PARTS improve maintainability.

===============================================================================
CSS
===============================================================================

Applications define structure.

CSS defines appearance.

Avoid using JavaScript for positioning.

For the Classic Character Sheet:

Fixed dimensions

Pixel-perfect positioning

Original paper sheet proportions

No responsive redesign

===============================================================================
SYSTEM UI CHECKBOXES — HARD CONVENTION
===============================================================================

This is a global WFRP1ED UI rule, not a per-feature styling preference.

ALL system-owned checkbox controls must use the agreed WFRP parchment checkbox
presentation in every current and future UI surface, including:

Actor sheets

Item sheets

ApplicationV2 windows

DialogV2 popups

configuration forms

management windows

future custom applications

Never intentionally expose the native Foundry/browser checkbox appearance.
In particular, the Foundry Accent Color black/orange checkbox must never be the
visible checkbox for a WFRP1ED-owned control.

Programmatically-created checkboxes should use:

module/ui/WfrpCheckbox.mjs

Handlebars markup may use the same canonical contract directly:

.wfrp1ed-checkbox

The visual contract is defined in:

css/forms/checkbox.css

SystemCheckboxIntegration.mjs is a defensive runtime safety net which
normalizes an accidentally raw checkbox in a WFRP1ED-owned ApplicationV2
window. It does not replace the coding requirement above: new code should use
the canonical checkbox contract at creation time.

When reviewing UI changes, a raw `input[type="checkbox"]` without the canonical
WFRP checkbox wrapper is a defect and should be fixed before the feature is
considered complete.

===============================================================================
SYSTEM TABS AND NAVIGATION — HARD CONVENTION
===============================================================================

Tabbed WFRP1ED surfaces must use one shared visual and behavioural contract.
This applies to current and future:

Actor sheets

Item sheets

ApplicationV2 windows

DialogV2 or modal workflows which genuinely require tabs

system-owned configuration/management windows

Do not invent a new tab font, colour, active marker, or button treatment for an
individual feature.

System-owned tab markup uses:

.wfrp1ed-tabs

.wfrp1ed-tab

The shared visual contract is defined in:

css/sheets/parchment-window.css

When Foundry owns the native tab markup, a thin system sheet integration may add
these classes at render time rather than duplicating or replacing Foundry's tab
controller.

Behavioural contract:

- The first/default tab is selected only when a new application instance opens.
- Once the user selects another tab, document updates and ordinary rerenders must
  preserve that selection.
- A create/update/delete operation inside the current tab must not silently send
  the user back to the default tab.
- Application-local ephemeral state should be kept outside Documents (for example
  WeakMap/application state) unless persistence across closing/reopening is an
  explicit feature requirement.
- Tab controls should expose tablist/tab semantics and aria-selected state.
- Keyboard navigation should be preserved when native Foundry tabs provide it;
  custom tab controllers should support the same predictable navigation where
  practical.

A tabbed surface which resets on rerender or uses an unrelated one-off visual
style is a defect and should not be considered complete.

===============================================================================
LEGACY CODE
===============================================================================

Avoid introducing:

getData()

activateListeners()

manual render pipelines

legacy ActorSheet patterns

Remove compatibility code once migration is complete.

===============================================================================
PROJECT ARCHITECTURE
===============================================================================

Game Rules

↓

Actor

↓

prepareDerivedData()

↓

DisplayBuilder

↓

_prepareContext()

↓

HandlebarsApplication

↓

Templates

↓

CSS

===============================================================================
CHECKLIST FOR NEW FEATURES
===============================================================================

For every feature ask:

□ Does the Actor own the game logic?

□ Are derived values calculated in prepareDerivedData()?

□ Is presentation created by DisplayBuilder?

□ Does _prepareContext() only assemble data?

□ Are templates rendering only?

□ Is CSS responsible for appearance?

□ Does every explicitly persisted ApplicationV2 control have exactly one
  persistence owner and avoid accidental generic form submission?

□ Does every system-owned checkbox use the canonical WFRP checkbox contract?

□ Does every tabbed WFRP surface use the shared tab style and preserve the
  user's selected tab across rerenders?

□ Has every rules/content identity been justified separately from its mechanical
  effects, and are internal IDs hidden or controlled according to the Rule
  Identity convention?

If any answer is NO,

the implementation should be reconsidered.

===============================================================================
CODE REVIEW CATEGORIES
===============================================================================

Every review should classify changes as:

KEEP

Code follows architecture.

REFACTOR

Improve structure without changing behaviour.

REMOVE

Delete obsolete or legacy code.

QUESTION

Insufficient context.
Ask before changing.

===============================================================================
LONG-TERM GOAL
===============================================================================

The WFRP1ED system should feel like a native Foundry V14 system.

Code should be understandable to any Foundry V14 developer without knowledge of
legacy ActorSheet architecture.

Whenever multiple valid implementations exist,

prefer the one that best matches modern Foundry V14 practices.

===============================================================================
LEARNING PRINCIPLE
===============================================================================

This project is also a learning exercise for Foundry V14.

When choosing between a quick compatibility solution and a native V14 solution,

prefer the native V14 solution,

provided it does not compromise WFRP 1st Edition authenticity or the MVP-first
development philosophy.

Understanding the framework is considered part of the project's success.
===============================================================================
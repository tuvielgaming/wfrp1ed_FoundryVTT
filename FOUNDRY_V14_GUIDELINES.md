# FOUNDRY_V14_GUIDELINES.md

Version: 1.2
Status: ACTIVE
Last Updated: 2026-08-25

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

□ Does every system-owned checkbox use the canonical WFRP checkbox contract?

□ Does every tabbed WFRP surface use the shared tab style and preserve the
  user's selected tab across rerenders?

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
# wfrp1ed_FoundryVTT

Why create this now?

Because I don't actually want CSS to own the layout.

CSS should render the layout.

The layout itself is data.

Later we can do things like:

ClassicLayout.pl
ClassicLayout.en
ClassicLayout.de

or

ClassicLayout["pl"]

if the English scan differs by a few pixels from the Polish one.

Even bigger idea

This is where I think we can build something that almost no Foundry system has.

Instead of manually editing CSS, we'll build a Layout Editor.

Imagine a GM setting:

Developer Mode

☑ Show layout

☑ Move sections

☑ Save coordinates

You drag the "Characteristics" block with the mouse.

When you're happy:

Save Layout

It exports:

characteristics: {

    x: 36,

    y: 167,

    width: 472,

    height: 305

}

directly into ClassicLayout.

No CSS editing.

No guessing.

No browser inspector.

This is the point where I'd like to slightly change our development strategy

Until now, I was thinking like a web developer.

After seeing how ambitious your system is becoming, I think we should think more like game engine developers.

So before we add another visual field, I'd like to build three small infrastructure pieces:

ThemeManager (backgrounds by language and sheet style)
LayoutManager (section coordinates from data instead of CSS)
DisplayBuilder (prepares all UI data for templates)

These three managers will become the backbone of every sheet you create—Classic, Modern, or Foundry-native. Once they're in place, adding a new sheet style will mostly be a matter of providing a different template, layout map, and theme, without duplicating logic. I think that investment will pay off throughout the rest of the project.

---

## Approved MVP Direction

The first playable release is the **Polish Classic Character Sheet** for
Foundry VTT v14.

The original Polish WFRP 1e character-sheet scan is used as the background and
visual specification. The MVP includes the complete overlay, all required Actor
and Item data structures and sheets, persistent editing, embedded Item
operations, derived values, core rolls and chat output needed for a GM to run a
first campaign without paper character sheets.

The Classic sheet uses a fixed canvas. ThemeManager selects localized visual
assets, while LayoutManager supplies localization-specific coordinates. This is
necessary because scans from different language editions can differ by small
pixel offsets. Polish assets and coordinates are implemented first; later
localizations may provide their own background and coordinate map without
changing game logic or shared template structure.

The optional Modern Character Sheet and visual Layout Editor remain future
presentation features. They must not delay completion of the Polish Classic
MVP.

`PROJECT_STATE.md` is authoritative for detailed scope and completion rules.

---

# Project Principles

This project is developed as a production-quality software project rather than
a prototype.

## Functional Specification

The implementation follows the official WFRP 1st Edition rules.

Priority of references:

1. English WFRP 1e Core Rulebook (canonical game mechanics)
2. Official Polish WFRP 1e Core Rulebook (official Polish terminology)
3. Original Polish Character Sheet (visual specification)
4. Foundry VTT v14 API (technical implementation)

Game mechanics are always verified against the English rulebook before
implementation. The Polish rulebook is used to preserve official terminology
and localization.

## Development Workflow

Development follows a Source-First workflow.

The currently uploaded repository is always treated as the implementation source
of truth.

No implementation is assumed to exist until it has been verified in the current
repository.

For larger changes, the current repository ZIP should be reviewed.

For focused work, development proceeds one file at a time:

1. Request one repository file.
2. Review the verified source.
3. Return one complete replacement file.
4. Replace the file in the repository.
5. Continue with the next dependency.

Partial snippets are avoided whenever possible.

## Engineering Principles

- JavaScript only (no TypeScript).
- No placeholder implementations.
- No duplicate calculations.
- One source of truth for every value.
- One canonical implementation path.
- No mixed legacy architectures.
- Verify before modifying.
- Keep architecture consistent with Foundry VTT v14.

## Long-Term Vision

The first milestone is a campaign-ready implementation of the Polish Classic
Character Sheet.

Support for official WFRP 1e supplements will be added later as optional,
switchable rule packages and compendium content without changing the core rules.
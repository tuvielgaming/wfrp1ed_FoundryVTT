# WFRP1ED localization conventions

This file records the project rule for localization so future system work does not repeat the same multi-step fixes.

## Foundry lifecycle rule

Foundry v14 core lifecycle is:

1. `init`
2. `i18nInit`
3. `setup`
4. `ready`

`i18nInit` fires **after localization translations have been loaded and are ready for use**, and before `setup`.

Therefore:

- Do **not** resolve localized visible strings during `init`.
- Do **not** branch on `game.i18n.lang`, Core language settings, browser locale, or similar language guesses during `init`.
- Any setting whose `name`, `hint`, `choices`, labels, or other visible content is localized must be registered from `i18nInit` (or later if there is a specific reason).
- Settings still need to exist before normal game setup, so `i18nInit` is the canonical registration point for localized WFRP1ED settings.

## Preferred translation pattern

For reusable/system UI text, define translation keys in both `lang/en.json` and `lang/pl.json`, then resolve them with:

```js
game.i18n.localize("WFRP1ED.Settings.Example.Name")
```

Do not duplicate language-detection logic in individual features.

For existing small bilingual runtime helpers, `game.i18n.lang` may be used only after `i18nInit` has fired. It must not be used to decide setting labels during `init`.

## Canonical settings example

```js
Hooks.once("i18nInit", () => {
    game.settings.register(game.system.id, "exampleSetting", {
        name: game.i18n.localize("WFRP1ED.Settings.Example.Name"),
        hint: game.i18n.localize("WFRP1ED.Settings.Example.Hint"),
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
    });
});
```

## Review checklist for every new setting

Before considering a new setting complete:

- setting registration happens at `i18nInit`, not `init`, if any visible text is localized;
- English and Polish labels/hints are both present;
- no custom early language detection exists;
- verify the setting once with Foundry UI in English and once in Polish;
- changing language and performing a full reload must show the corresponding labels.

## Why this rule exists

The project previously registered localized World Settings during `init` and tried to infer the active language manually. Foundry v14 documents that translations are only guaranteed to be ready at `i18nInit`. Manual early language detection caused settings to appear in English even while the rest of the Foundry UI was Polish.

# WFRP1ED ammunition World Settings

This file records the authoritative relationship between ammunition quantity tracking and Quick Access enforcement.

## Track ammunition quantities

Setting id: `trackAmmunitionQuantities`

Default: **ON**.

When enabled, ranged weapons which require external ammunition select a compatible Equipment ammunition stack and consume its quantity. Internal-magazine weapons select/consume compatible ammunition when the magazine is refilled.

When disabled, ammunition is abstract: direct shots do not require an ammunition stack, no ammunition selector is shown, and Equipment quantities are not consumed automatically.

## Enforce Quick Access ammunition

Setting id: `trackAccessibleAmmunition`.

The legacy id is intentionally retained so worlds which previously enabled `Track readily accessible ammunition` keep that preference after the setting is renamed/narrowed.

Default: **OFF**.

This setting only changes **where a direct shot may obtain tracked ammunition**:

- OFF: any compatible ammunition stack carried by the Actor may be selected and consumed, regardless of container/location.
- ON: a direct shot without an internal magazine may automatically use only ammunition stored in a matching Quick Access Ammunition container. Compatible ammunition elsewhere is reserve ammunition and uses the GM-adjudication workflow.
- Internal-magazine refill remains an explicit reload action and may select compatible ammunition from anywhere in the Actor inventory.

## Dependency rule

Quick Access enforcement depends on quantity tracking.

- Turning **Enforce Quick Access ammunition ON** while quantity tracking is OFF automatically turns **Track ammunition quantities ON** and shows an informational Foundry notification explaining the dependency.
- Turning **Track ammunition quantities OFF** while Quick Access enforcement is ON automatically turns **Enforce Quick Access ammunition OFF** and shows an informational notification.

This is ordinary Settings/UI feedback, not a GM Gameplay Notice.

## Localization rule

Both settings are registered on `i18nInit` and use translation keys from `lang/en.json` and `lang/pl.json`, following `docs/LOCALIZATION-CONVENTIONS.md`. Do not reintroduce language detection during `init`.

## Expected configuration matrix

| Track quantities | Enforce Quick Access | Result |
| --- | --- | --- |
| OFF | OFF | Abstract ammunition; no selection or automatic quantity consumption. |
| ON | OFF | Select and consume compatible ammunition from anywhere in Actor inventory. |
| ON | ON | Select/consume Quick Access ammunition for direct shots; reserve ammunition requires GM adjudication. |
| OFF | ON | Invalid combination; system automatically resolves the dependency. |

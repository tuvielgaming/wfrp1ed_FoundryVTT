import { HUMANOID_HIT_LOCATIONS } from "../combat/HitLocation.mjs";
import { CriticalWoundItemSheet } from "../sheets/CriticalWoundItemSheet.mjs";

installCriticalHitLocationOptions();

/**
 * Critical Wounds author the same canonical humanoid hit-location IDs used by
 * combat damage. The empty value is intentional: a side-dependent consequence
 * such as "drop from injured hand" may resolve the physical arm when the wound
 * is applied to an Actor.
 */
function installCriticalHitLocationOptions() {
	if (CriticalWoundItemSheet.prototype.__wfrpHitLocationOptionsInstalled === true) return;

	const original = CriticalWoundItemSheet.prototype._prepareContext;
	CriticalWoundItemSheet.prototype._prepareContext = async function criticalHitLocationContext(options) {
		const context = await original.call(this, options);
		context.ui ??= {};
		context.ui.hitLocationOptions = hitLocationOptions();
		return context;
	};

	Object.defineProperty(
		CriticalWoundItemSheet.prototype,
		"__wfrpHitLocationOptionsInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function hitLocationOptions() {
	const labels = {
		head: localize("Head", "Głowa"),
		rightArm: localize("Right arm", "Prawa ręka"),
		leftArm: localize("Left arm", "Lewa ręka"),
		body: localize("Body", "Korpus"),
		rightLeg: localize("Right leg", "Prawa noga"),
		leftLeg: localize("Left leg", "Lewa noga"),
	};

	return Object.fromEntries([
		["", localize("None / resolve when applied", "Brak / ustal przy zastosowaniu")],
		...HUMANOID_HIT_LOCATIONS.map((id) => [id, labels[id] ?? id]),
	]);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
	ARMOUR_PIECE,
} from "../data-models/item/ArmourData.mjs";
import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";

const ALLOWED_LAYER_PAIRS = Object.freeze(new Set([
	pairKey(ARMOUR_PIECE.LEGGINGS, ARMOUR_PIECE.MAIL_COAT),
	pairKey(ARMOUR_PIECE.LEGGINGS, ARMOUR_PIECE.SLEEVED_MAIL_COAT),
	pairKey(ARMOUR_PIECE.BREASTPLATE, ARMOUR_PIECE.MAIL_SHIRT),
	pairKey(ARMOUR_PIECE.BREASTPLATE, ARMOUR_PIECE.SLEEVED_MAIL_SHIRT),
	pairKey(ARMOUR_PIECE.BREASTPLATE, ARMOUR_PIECE.MAIL_COAT),
	pairKey(ARMOUR_PIECE.BREASTPLATE, ARMOUR_PIECE.SLEEVED_MAIL_COAT),
	pairKey(ARMOUR_PIECE.HELMET, ARMOUR_PIECE.MAIL_COIF),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.SLEEVED_MAIL_SHIRT),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.SLEEVED_MAIL_COAT),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.MAIL_ARM_BRACER),
]));

const OPTIONAL_INITIATIVE_PENALTY_PAIRS = Object.freeze(new Set([
	pairKey(ARMOUR_PIECE.LEGGINGS, ARMOUR_PIECE.MAIL_COAT),
	pairKey(ARMOUR_PIECE.LEGGINGS, ARMOUR_PIECE.SLEEVED_MAIL_COAT),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.SLEEVED_MAIL_SHIRT),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.SLEEVED_MAIL_COAT),
	pairKey(ARMOUR_PIECE.PLATE_ARM_BRACER, ARMOUR_PIECE.MAIL_ARM_BRACER),
]));

const MAIL_PIECES = Object.freeze(new Set([
	ARMOUR_PIECE.MAIL_SHIRT,
	ARMOUR_PIECE.SLEEVED_MAIL_SHIRT,
	ARMOUR_PIECE.MAIL_COAT,
	ARMOUR_PIECE.SLEEVED_MAIL_COAT,
	ARMOUR_PIECE.MAIL_COIF,
	ARMOUR_PIECE.MAIL_ARM_BRACER,
]));

const PLATE_PIECES = Object.freeze(new Set([
	ARMOUR_PIECE.BREASTPLATE,
	ARMOUR_PIECE.PLATE_ARM_BRACER,
	ARMOUR_PIECE.HELMET,
]));

/**
 * Validate a proposed WFRP 1e armour loadout before an Armour Item is worn.
 *
 * Core p.121 does not define a generic material-layer hierarchy. It lists only
 * four families of legal overlap: leggings under a mail coat, breastplate over
 * mail body armour, helmet over mail coif, and plate arm bracers over sleeved
 * mail or mail arm bracers. All other overlapping armour is illegal.
 *
 * The result is rule data only. Callers decide how to present errors/warnings.
 */
export class ArmourEquipValidator {
	static validate(actor, candidate) {
		assertActor(actor);
		assertArmour(candidate);

		const identityProblem = coreIdentityProblem(candidate);
		if (identityProblem) {
			return invalidResult([
				conflict("none", candidate, identityProblem),
			]);
		}

		if (candidate.system?.armourClass === ARMOUR_CLASS.SHIELD) {
			return validResult();
		}

		const locations = coveredLocations(candidate);
		if (locations.length === 0) {
			return invalidResult([
				conflict(
					"none",
					candidate,
					localize(
						"This armour does not cover any body area.",
						"Ten pancerz nie chroni żadnego obszaru ciała.",
					),
				),
			]);
		}

		const conflicts = [];
		const warnings = [];
		const worn = activeWornArmour(actor, candidate);

		for (const location of locations) {
			const overlapping = worn.filter(
				(item) => item.system?.coverage?.[location] === true,
			);

			if (overlapping.length === 0) continue;

			/*
			 * The Core examples all produce exactly 2 AP by wearing two pieces.
			 * No three-piece stack is listed, and the text states that the named
			 * cases are the only circumstances in which armour may overlap.
			 */
			if (overlapping.length > 1) {
				conflicts.push(conflict(
					location,
					candidate,
					localize(
						"This body area already has the maximum legal armour layering.",
						"Na tym obszarze ciała jest już maksymalna dozwolona liczba warstw pancerza.",
					),
					overlapping,
				));
				continue;
			}

			const existing = overlapping[0];
			const existingIdentityProblem = coreIdentityProblem(existing);
			if (existingIdentityProblem) {
				conflicts.push(conflict(
					location,
					candidate,
					existingIdentityProblem,
					[existing],
				));
				continue;
			}

			const candidatePiece = piece(candidate);
			const existingPiece = piece(existing);

			if (
				candidatePiece === ARMOUR_PIECE.CUSTOM ||
				existingPiece === ARMOUR_PIECE.CUSTOM
			) {
				conflicts.push(conflict(
					location,
					candidate,
					localize(
						"The Core layering rule cannot be verified for custom armour pieces.",
						"Nie można zweryfikować zasad nakładania warstw dla niestandardowego elementu pancerza.",
					),
					[existing],
				));
				continue;
			}

			const key = pairKey(candidatePiece, existingPiece);
			if (!ALLOWED_LAYER_PAIRS.has(key)) {
				conflicts.push(conflict(
					location,
					candidate,
					localize(
						"These armour pieces may not be worn over one another under the Core rules.",
						"Zgodnie z zasadami podstawowymi tych elementów pancerza nie można nosić jeden na drugim.",
					),
					[existing],
				));
				continue;
			}

			if (OPTIONAL_INITIATIVE_PENALTY_PAIRS.has(key)) {
				warnings.push(Object.freeze({
					location,
					message: localize(
						"The GM may optionally apply -10 Initiative for this armour combination.",
						"MG może opcjonalnie zastosować -10 do Inicjatywy za tę kombinację pancerza.",
					),
					existingItemUuid: String(existing.uuid ?? ""),
					existingItemName: String(existing.name ?? ""),
				}));
			}
		}

		return conflicts.length > 0
			? invalidResult(conflicts, warnings)
			: validResult(warnings);
	}

	static canEquip(actor, candidate) {
		return this.validate(actor, candidate).valid;
	}
}

function activeWornArmour(actor, candidate) {
	return [...(actor.items ?? [])].filter((item) =>
		item?.type === "armour" &&
		item.id !== candidate.id &&
		item.system?.armourClass !== ARMOUR_CLASS.SHIELD &&
		item.system?.state?.mode === INVENTORY_MODE.WORN,
	);
}

function coveredLocations(item) {
	return ARMOUR_LOCATIONS.filter(
		(location) => item.system?.coverage?.[location] === true,
	);
}

function piece(item) {
	const value = String(item.system?.piece ?? "");
	return Object.values(ARMOUR_PIECE).includes(value)
		? value
		: ARMOUR_PIECE.CUSTOM;
}

function coreIdentityProblem(item) {
	const armourPiece = piece(item);
	const armourClass = String(item.system?.armourClass ?? "");

	if (armourPiece === ARMOUR_PIECE.CUSTOM) return "";

	if (armourPiece === ARMOUR_PIECE.SHIELD) {
		return armourClass === ARMOUR_CLASS.SHIELD
			? ""
			: identityMessage(item);
	}

	if (MAIL_PIECES.has(armourPiece)) {
		return armourClass === ARMOUR_CLASS.MAIL
			? ""
			: identityMessage(item);
	}

	if (PLATE_PIECES.has(armourPiece)) {
		return armourClass === ARMOUR_CLASS.PLATE
			? ""
			: identityMessage(item);
	}

	if (armourPiece === ARMOUR_PIECE.LEGGINGS) {
		return [ARMOUR_CLASS.MAIL, ARMOUR_CLASS.PLATE].includes(armourClass)
			? ""
			: identityMessage(item);
	}

	return "";
}

function identityMessage(item) {
	return localize(
		`The selected Core armour piece does not match the armour class on '${item.name}'.`,
		`Wybrany element pancerza z zasad nie pasuje do rodzaju pancerza przedmiotu „${item.name}”.`,
	);
}

function pairKey(left, right) {
	return [String(left ?? ""), String(right ?? "")].sort().join("::");
}

function conflict(location, candidate, message, existing = []) {
	return Object.freeze({
		location,
		candidateItemUuid: String(candidate.uuid ?? ""),
		candidateItemName: String(candidate.name ?? ""),
		message,
		existingItems: Object.freeze(existing.map((item) => Object.freeze({
			itemUuid: String(item.uuid ?? ""),
			itemName: String(item.name ?? ""),
			piece: piece(item),
		}))),
	});
}

function validResult(warnings = []) {
	return foundry.utils.deepFreeze({
		valid: true,
		conflicts: [],
		warnings,
	});
}

function invalidResult(conflicts, warnings = []) {
	return foundry.utils.deepFreeze({
		valid: false,
		conflicts,
		warnings,
	});
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Armour equip validation requires an Actor.");
	}
}

function assertArmour(item) {
	if (!(item instanceof foundry.documents.Item) || item.type !== "armour") {
		throw new Error("Armour equip validation requires an Armour Item.");
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

import {
	RACE_CAREER_CLASSES,
	RACE_CAREER_OVERRIDE_MODE,
	RACE_CHARACTERISTIC_IDS,
	RACE_INITIAL_SKILL_MODE,
	RaceData,
} from "../data-models/item/RaceData.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/**
 * Register the native WFRP 1e Race document contract.
 *
 * World and Compendium Race Items are reusable definitions. A Character owns
 * at most one embedded Race Item, which is its authoritative racial identity.
 * Creation rolls are deliberately not executed here; the future creation
 * engine will consume the Race definition and write generated results to the
 * Character.
 */
Hooks.once("init", () => {
	CONFIG.Item.dataModels.race = RaceData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		RaceItemSheet,
		{
			types: ["race"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		race: Object.freeze({
			...(game.WFRP1ED?.race ?? {}),
			characteristics: RACE_CHARACTERISTIC_IDS,
			careerClasses: RACE_CAREER_CLASSES,
			initialSkillMode: RACE_INITIAL_SKILL_MODE,
			careerOverrideMode: RACE_CAREER_OVERRIDE_MODE,
		}),
	});
});

/**
 * A Character may contain exactly zero or one Race Item.
 *
 * There is intentionally no migration or guessing from an old free-text race.
 * If a test Character has obsolete state, recreate it or delete the old Race
 * Item and embed the desired one.
 */
Hooks.on("preCreateItem", (item, _data, _options, userId) => {
	if (item?.type !== "race") return;

	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const existing = actor.items?.find?.((candidate) => candidate.type === "race");
	if (!existing) return;

	if (game.user?.id === userId) {
		ui.notifications.warn(localize(
			`${actor.name} already has the Race '${existing.name}'. Remove it before assigning another Race.`,
			`${actor.name} ma już Rasę „${existing.name}”. Usuń ją przed przypisaniem innej Rasy.`,
		));
	}

	return false;
});

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

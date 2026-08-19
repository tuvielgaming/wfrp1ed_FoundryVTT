import { CareerProgression, careerClassLabel } from "./CareerProgression.mjs";
import { DisplayBuilder } from "../display/DisplayBuilder.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

installCareerDropProgression();
installCareerSkillOffers();
installCareerDisplayLabels();
installCareerSheetInteractions();

/**
 * Supersede the earlier character-creation-only Career drop wrapper.
 * Non-Career drops continue through the existing chain unchanged.
 */
function installCareerDropProgression() {
	if (ClassicActorSheet.prototype.__wfrpCareerProgressionDropInstalled === true) return;
	const previous = ClassicActorSheet.prototype._onDropItem;
	if (typeof previous !== "function") {
		console.error("WFRP1ED | Career progression could not install: ClassicActorSheet has no _onDropItem.");
		return;
	}

	ClassicActorSheet.prototype._onDropItem = async function progressionAwareCareerDrop(event, item) {
		if (item?.type !== "career") return previous.call(this, event, item);
		try {
			if (CareerProgression.initialCareerLocked(this.document)) {
				return await CareerProgression.transferCareer(this, item);
			}
			return await CareerProgression.assignInitialCareer(this, item);
		} catch (error) {
			console.error("WFRP1ED | Career drop progression failed.", error);
			ui.notifications.error(error?.message ?? localize(
				"Unable to apply the Career.",
				"Nie udało się zastosować Profesji.",
			));
			return null;
		}
	};

	Object.defineProperty(
		ClassicActorSheet.prototype,
		"__wfrpCareerProgressionDropInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** Append derived, unowned active-Career Skills to the printed Skill list. */
function installCareerSkillOffers() {
	if (DisplayBuilder.__wfrpCareerSkillOffersInstalled === true) return;
	const original = DisplayBuilder.skills;
	DisplayBuilder.skills = function careerAwareSkills(document) {
		const owned = original.call(this, document);
		if (document?.type !== "character") return owned;
		const offers = CareerProgression.skillOffers(document).map((offer) => Object.freeze({
			id: "",
			uuid: offer.sourceUuid,
			name: offer.name,
			displayName: offer.name,
			description: offer.description,
			specialisation: "",
			careerOffer: true,
			careerOfferKey: offer.key,
			careerName: offer.careerName,
			cost: offer.cost,
		}));
		return [...owned, ...offers];
	};

	Object.defineProperty(
		DisplayBuilder,
		"__wfrpCareerSkillOffersInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** Localize canonical Career Class ids in the original-sheet header. */
function installCareerDisplayLabels() {
	if (DisplayBuilder.__wfrpCareerClassLabelsInstalled === true) return;
	const original = DisplayBuilder.details;
	DisplayBuilder.details = function localizedCareerDetails(document) {
		const details = original.call(this, document);
		if (document?.type !== "character") return details;
		const career = CareerProgression.activeCareer(document);
		if (!career) return details;
		return {
			...details,
			currentCareer: String(career.name ?? details.currentCareer ?? ""),
			careerClass: careerClassLabel(career.system?.class),
		};
	};

	Object.defineProperty(
		DisplayBuilder,
		"__wfrpCareerClassLabelsInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function installCareerSheetInteractions() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (
			actor?.documentName !== "Actor" ||
			actor.type !== "character" ||
			!element?.querySelector?.(".wfrp1ed-classic-sheet")
		) return;

		wireSkillOffers(application, element);
		wireCareerExits(application, element);
		wireCareerExitHelp(element);
		wireCareerHistory(application, element);
		wireCurrentCareer(application, element);
	});
}

function wireSkillOffers(sheet, element) {
	for (const button of element.querySelectorAll("[data-career-skill-offer]")) {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const offerKey = String(button.dataset.careerSkillOffer ?? "");
			if (!offerKey) return;
			void handleSkillOfferClick(sheet, offerKey, event);
		});
	}
}

async function handleSkillOfferClick(sheet, offerKey, event) {
	try {
		if (event.ctrlKey || event.metaKey) {
			if (sheet.isEditable !== true) {
				throw new Error(localize(
					"You do not have permission to buy this Skill.",
					"Nie masz uprawnień do wykupienia tej Umiejętności.",
				));
			}
			const transaction = await CareerProgression.purchaseSkill(sheet.document, offerKey);
			ui.notifications.info(localize(
				`Career Skill purchased for ${transaction.cost} Experience Points.`,
				`Wykupiono Umiejętność Profesji za ${transaction.cost} Punktów Doświadczenia.`,
			));
			return;
		}
		await CareerProgression.openSkillOffer(sheet.document, offerKey);
	} catch (error) {
		console.error("WFRP1ED | Career Skill action failed.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to use the Career Skill entry.",
			"Nie udało się użyć wpisu Umiejętności Profesji.",
		));
	}
}

function wireCareerExits(sheet, element) {
	const offers = CareerProgression.exitOffers(sheet.document);
	const entries = [...element.querySelectorAll(
		".header-field--career-exits .header-list-entry",
	)];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const offer = offers[index];
		if (!offer) continue;
		entry.dataset.careerExitIndex = String(index);
		entry.tabIndex = 0;
		entry.setAttribute("role", "button");
		entry.title = localize(
			`Click to open ${offer.name}. Ctrl/Cmd + click to change Career for ${offer.cost} Experience Points.`,
			`Kliknij, aby otworzyć ${offer.name}. Ctrl/Cmd + kliknięcie zmienia Profesję za ${offer.cost} Punktów Doświadczenia.`,
		);
		entry.addEventListener("click", (event) => {
			event.preventDefault();
			void handleCareerExitClick(sheet, index, event);
		});
		entry.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void handleCareerExitClick(sheet, index, event);
		});
	}
}

/**
 * Reuse the same circular '?' affordance as the characteristic-row helpers.
 * It lives outside the scroll viewport so the instruction remains visible even
 * while the Career Exit list itself is being scrolled.
 */
function wireCareerExitHelp(element) {
	const header = element.querySelector(".sheet-header");
	if (!(header instanceof HTMLElement)) return;
	if (header.querySelector("[data-wfrp-career-exit-help]")) return;

	const help = document.createElement("span");
	help.className = "characteristics-help header-career-exits-help";
	help.dataset.wfrpCareerExitHelp = "";
	help.dataset.tooltip = localize(
		"Ctrl/Cmd + click a Career Exit to transfer to that Career for Experience Points.",
		"Ctrl/Cmd + kliknięcie Profesji wyjściowej: przejdź do tej Profesji za Punkty Doświadczenia.",
	);
	help.setAttribute("aria-label", help.dataset.tooltip);
	help.tabIndex = 0;
	help.textContent = "?";
	header.append(help);
}

async function handleCareerExitClick(sheet, index, event) {
	try {
		if (event.ctrlKey || event.metaKey) {
			if (sheet.isEditable !== true) {
				throw new Error(localize(
					"You do not have permission to change this character's Career.",
					"Nie masz uprawnień do zmiany Profesji tej postaci.",
				));
			}
			const transaction = await CareerProgression.transferFromExit(sheet, index);
			if (transaction) {
				ui.notifications.info(localize(
					`Career changed for ${transaction.cost} Experience Points.`,
					`Zmieniono Profesję za ${transaction.cost} Punktów Doświadczenia.`,
				));
			}
			return;
		}
		await CareerProgression.openExit(sheet.document, index);
	} catch (error) {
		console.error("WFRP1ED | Career Exit action failed.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to use the Career Exit.",
			"Nie udało się użyć Profesji wyjściowej.",
		));
	}
}

function wireCareerHistory(sheet, element) {
	const history = Array.isArray(sheet.document?.system?.details?.careerHistory)
		? sheet.document.system.details.careerHistory
		: [];
	const entries = [...element.querySelectorAll(
		".header-field--career-history .header-list-entry",
	)];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const historyEntry = history[index];
		const uuid = String(historyEntry?.uuid ?? "").trim();
		if (!uuid) continue;

		entry.dataset.careerHistoryIndex = String(index);
		entry.tabIndex = 0;
		entry.setAttribute("role", "button");
		entry.title = localize(
			`Click to open ${historyEntry?.name ?? "this Career"}.`,
			`Kliknij, aby otworzyć ${historyEntry?.name ?? "tę Profesję"}.`,
		);
		entry.addEventListener("click", (event) => {
			event.preventDefault();
			void openCareerHistoryEntry(uuid);
		});
		entry.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void openCareerHistoryEntry(uuid);
		});
	}
}

async function openCareerHistoryEntry(uuid) {
	try {
		const career = await foundry.utils.fromUuid(uuid);
		if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
			throw new Error(localize(
				"The Career stored in Career Path is no longer available.",
				"Profesja zapisana w Przebiegu kariery nie jest już dostępna.",
			));
		}
		await career.sheet.render({ force: true });
	} catch (error) {
		console.error("WFRP1ED | Career Path action failed.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to open the Career from Career Path.",
			"Nie udało się otworzyć Profesji z Przebiegu kariery.",
		));
	}
}

function wireCurrentCareer(sheet, element) {
	const input = element.querySelector(".header-field--current-career input");
	const career = CareerProgression.activeCareer(sheet.document);
	if (!(input instanceof HTMLInputElement) || !career) return;
	input.style.cursor = "pointer";
	input.title = localize(
		"Click to open the current Career.",
		"Kliknij, aby otworzyć aktualną Profesję.",
	);
	input.addEventListener("click", (event) => {
		event.preventDefault();
		void career.sheet.render({ force: true });
	});
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

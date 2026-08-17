import {
	CAREER_DOCUMENT_TYPE,
	CAREER_ENTRY_MODE,
	CAREER_TIER,
} from "../data-models/item/CareerData.mjs";

const { DialogV2 } = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const INITIAL_CAREER_LOCK_FLAG_KEY = "initialCareerLocked";
const LAST_ADVANCE_FLAG_KEY = "lastCharacteristicAdvance";
const CAREER_SOURCE_FLAG_KEY = "careerSource";
const CAREER_ACQUISITION_FLAG_KEY = "careerAcquisition";
const CAREER_GRANT_FLAG_KEY = "careerGrant";
const CAREER_TRANSACTION_FLAG_KEY = "careerProgressionTransaction";
const CAREER_COMPANION_FLAG_KEY = "careerCompanion";
const CORE_CATALOG_FLAG_KEY = "coreCatalog";
const VERSION = 1;

export const CAREER_SKILL_COST = 100;
export const CAREER_TRANSFER_COST = 100;
export const CROSS_CLASS_BASIC_TRANSFER_COST = 200;

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

/**
 * Authoritative WFRP 1e Career progression service.
 *
 * Core contracts implemented here:
 * - initial-Career Skills/Trappings are resolved during character creation;
 * - percentage entries roll once, and alternatives preserve player/random policy;
 * - later Career Skills are offers, never automatic grants, and cost 100 EP;
 * - changing to a listed Career Exit costs 100 EP;
 * - changing to any Basic Career costs 100 EP within class or 200 EP across class;
 * - changing Career replaces the Advance Scheme ceiling; purchased advances remain;
 * - old Skills remain after changing Career;
 * - later Careers grant no starting Trappings.
 */
export class CareerProgression {
	static activeCareer(actor) {
		return [...(actor?.items ?? [])].find(
			(item) => item?.type === "career" && readBoolean(item.system?.current),
		) ?? null;
	}

	static initialCareerLocked(actor) {
		if (actor?.getFlag?.(FLAG_SCOPE, INITIAL_CAREER_LOCK_FLAG_KEY) === true) {
			return true;
		}
		if (nonNegativeInteger(actor?.system?.experience?.spent) > 0) return true;
		return isObject(actor?.getFlag?.(FLAG_SCOPE, LAST_ADVANCE_FLAG_KEY));
	}

	/** Resolve one Career Skill offer from its stable rendered key. */
	static skillOffer(actor, offerKey) {
		const career = this.activeCareer(actor);
		if (!career) return null;
		return this.skillOffers(actor).find((offer) => offer.key === offerKey) ?? null;
	}

	/**
	 * Derive unowned Skills offered by the active Career.
	 *
	 * The offer is presentation/progression state, not a fake embedded Skill Item.
	 * Once purchased (or already owned), the same identity disappears from this
	 * list automatically. Identity includes specialisation.
	 */
	static skillOffers(actor) {
		const career = this.activeCareer(actor);
		if (!career) return [];

		const owned = new Set(
			[...(actor.items ?? [])]
				.filter((item) => item?.type === "skill")
				.map((item) => skillIdentityFromItem(item)),
		);
		const seen = new Set();
		const offers = [];

		for (const entry of careerEntries(career, "skills")) {
			for (const choice of entry.choices ?? []) {
				for (let grantIndex = 0; grantIndex < (choice.grants ?? []).length; grantIndex += 1) {
					const grant = choice.grants[grantIndex];
					if (String(grant?.documentSubtype ?? "") !== "skill") continue;
					const source = sourceDocumentSync(grant);
					const identity = skillIdentityFromGrant(grant, source);
					if (!identity || owned.has(identity) || seen.has(identity)) continue;
					seen.add(identity);
					offers.push(Object.freeze({
						key: `${entry.id}::${choice.id}::${grantIndex}`,
						careerId: career.id,
						careerUuid: career.uuid,
						careerName: String(career.name ?? ""),
						entryId: String(entry.id ?? ""),
						choiceId: String(choice.id ?? ""),
						grantIndex,
						identity,
						name: grantDisplayName(grant, source),
						description: itemDescription(source),
						sourceUuid: String(grant?.uuid ?? ""),
						cost: CAREER_SKILL_COST,
					}));
				}
			}
		}
		return offers;
	}

	static exitOffers(actor) {
		const career = this.activeCareer(actor);
		if (!career) return [];
		return careerExits(career).map((exit, index) => Object.freeze({
			index,
			careerId: career.id,
			name: resolvedReferenceName(exit),
			uuid: String(exit?.uuid ?? ""),
			rulesId: String(exit?.rulesId ?? ""),
			condition: String(exit?.condition ?? ""),
			requiresComplete: exit?.requiresComplete === true,
			excludedRaces: Array.isArray(exit?.excludedRaces)
				? [...exit.excludedRaces]
				: [],
			cost: CAREER_TRANSFER_COST,
		}));
	}

	static async openSkillOffer(actor, offerKey) {
		const offer = this.skillOffer(actor, offerKey);
		if (!offer) throw new Error(localize(
			"This Career Skill offer is no longer available.",
			"Ta Umiejętność Profesji nie jest już dostępna.",
		));
		const source = offer.sourceUuid
			? await foundry.utils.fromUuid(offer.sourceUuid)
			: null;
		if (!(source instanceof foundry.documents.Item) || source.type !== "skill") {
			throw new Error(localize(
				"The source Skill Item is not available.",
				"Źródłowy Przedmiot Umiejętności nie jest dostępny.",
			));
		}
		await source.sheet.render({ force: true });
		return source;
	}

	static async openExit(actor, exitIndex) {
		const offer = this.exitOffers(actor)[exitIndex];
		if (!offer) throw new Error(localize(
			"This Career Exit is no longer available.",
			"Ta Profesja wyjściowa nie jest już dostępna.",
		));
		const career = offer.uuid ? await foundry.utils.fromUuid(offer.uuid) : null;
		if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
			throw new Error(localize(
				"The referenced Career Item is not available.",
				"Powiązany Przedmiot Profesji nie jest dostępny.",
			));
		}
		await career.sheet.render({ force: true });
		return career;
	}

	/** Assign or replace the initial Career while character creation remains open. */
	static async assignInitialCareer(sheet, droppedCareer) {
		const actor = sheet?.document;
		assertCharacterActor(actor);
		assertEditableSheet(sheet);
		if (this.initialCareerLocked(actor)) {
			throw new Error(localize(
				"The initial Career is permanently locked because Experience Point spending has begun.",
				"Profesja początkowa jest trwale zablokowana, ponieważ rozpoczęto wydawanie Punktów Doświadczenia.",
			));
		}
		assertCareerItem(droppedCareer);

		const oldCareer = this.activeCareer(actor);
		const oldDetails = cloneDetails(actor);
		const oldScheme = characteristicCareerSnapshot(actor);
		const oldMagicPoints = nonNegativeInteger(actor.system?.status?.magicPoints);

		let selected = null;
		let createdCareer = false;
		let acquisition = null;

		try {
			selected = await ensureEmbeddedCareer(actor, droppedCareer, {
				initial: true,
			});
			createdCareer = String(selected.id) !== String(droppedCareer.id) ||
				String(droppedCareer.parent?.uuid ?? "") !== String(actor.uuid ?? "");

			await setCurrentCareer(actor, selected, oldCareer);
			await applyAdvanceScheme(actor, selected);

			acquisition = await resolveInitialPackage(actor, selected);
			await selected.setFlag(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY, acquisition);

			const details = cloneDetails(actor);
			details.currentCareer = "";
			details.careerClass = "";
			details.careerHistory = [{
				name: String(selected.name ?? ""),
				uuid: String(selected.uuid ?? ""),
				completed: false,
			}];
			details.careerExits = careerExits(selected).map((exit) => resolvedReferenceName(exit));
			await actor.update({ "system.details": details });

			if (oldCareer && String(oldCareer.id) !== String(selected.id)) {
				await removeInitialCareerPackage(actor, oldCareer);
				if (actor.items?.has?.(oldCareer.id)) {
					await actor.deleteEmbeddedDocuments("Item", [oldCareer.id]);
				}
			}

			await publishInitialCareerSummary(actor, selected, acquisition);
			void actor.sheet?.render?.();
			return selected;
		} catch (error) {
			if (acquisition) {
				await rollbackAcquisition(actor, acquisition).catch(() => {});
			}
			await restoreCharacteristicCareerSnapshot(actor, oldScheme).catch(() => {});
			await actor.update({
				"system.status.magicPoints": oldMagicPoints,
				"system.details": oldDetails,
			}).catch(() => {});

			if (oldCareer && actor.items?.has?.(oldCareer.id)) {
				await actor.updateEmbeddedDocuments("Item", [{
					_id: oldCareer.id,
					"system.current": true,
				}]).catch(() => {});
			}
			if (selected?.id && String(selected.id) !== String(oldCareer?.id ?? "") && actor.items?.has?.(selected.id)) {
				if (createdCareer) {
					await actor.deleteEmbeddedDocuments("Item", [selected.id]).catch(() => {});
				} else {
					await actor.updateEmbeddedDocuments("Item", [{
						_id: selected.id,
						"system.current": false,
					}]).catch(() => {});
				}
			}
			throw error;
		}
	}

	/**
	 * Buy one unowned Skill from the active Career for 100 EP.
	 * The Item create is rolled back if the Actor-side XP transaction fails.
	 */
	static async purchaseSkill(actor, offerKey) {
		assertCharacterActor(actor);
		assertActorEditable(actor);
		const offer = this.skillOffer(actor, offerKey);
		if (!offer) throw new Error(localize(
			"This Career Skill is already owned or no longer offered.",
			"Ta Umiejętność Profesji jest już posiadana albo nie jest już dostępna.",
		));
		assertAvailableExperience(actor, CAREER_SKILL_COST);

		const career = this.activeCareer(actor);
		const grant = grantForOffer(career, offer);
		if (!grant) throw new Error("Career Skill grant could not be resolved.");
		const source = await sourceDocument(grant);
		if (hasSkillIdentity(actor, skillIdentityFromGrant(grant, source))) {
			throw new Error(localize(
				"The character already has this Skill.",
				"Postać posiada już tę Umiejętność.",
			));
		}

		const itemSource = await skillSourceForGrant(grant, source);
		itemSource.flags ??= {};
		itemSource.flags[FLAG_SCOPE] ??= {};
		itemSource.flags[FLAG_SCOPE][CAREER_GRANT_FLAG_KEY] = {
			version: VERSION,
			careerItemId: String(career.id ?? ""),
			careerUuid: String(career.uuid ?? ""),
			kind: "purchased-skill",
			sourceUuid: String(grant?.uuid ?? ""),
			createdAt: Date.now(),
		};

		const created = await actor.createEmbeddedDocuments("Item", [itemSource]);
		const skill = created[0];
		if (!skill) throw new Error("Foundry did not create the purchased Skill Item.");

		try {
			const spentBefore = nonNegativeInteger(actor.system?.experience?.spent);
			const transaction = {
				version: VERSION,
				id: foundry.utils.randomID(),
				kind: "career-skill",
				state: "applied",
				careerItemId: String(career.id ?? ""),
				skillItemId: String(skill.id ?? ""),
				offerKey,
				cost: CAREER_SKILL_COST,
				spentBefore,
				spentAfter: spentBefore + CAREER_SKILL_COST,
				userId: String(game.user?.id ?? ""),
				createdAt: Date.now(),
			};
			await actor.update({
				"system.experience.spent": transaction.spentAfter,
				[`flags.${FLAG_SCOPE}.${CAREER_TRANSACTION_FLAG_KEY}`]: transaction,
			});
			void actor.sheet?.render?.();
			return Object.freeze({ ...transaction, skill });
		} catch (error) {
			await actor.deleteEmbeddedDocuments("Item", [skill.id]).catch(() => {});
			throw error;
		}
	}

	/** Core Career change by drop or by a Career Exit click. */
	static async transferCareer(sheet, targetCareer, { exitIndex = null } = {}) {
		const actor = sheet?.document ?? sheet;
		assertCharacterActor(actor);
		if (sheet?.document) assertEditableSheet(sheet);
		else assertActorEditable(actor);
		assertCareerItem(targetCareer);

		const current = this.activeCareer(actor);
		if (!current) throw new Error(localize(
			"Assign an initial Career before changing Careers.",
			"Najpierw przypisz profesję początkową.",
		));
		if (sameCareerReference(current, targetCareer)) {
			throw new Error(localize(
				"This is already the character's current Career.",
				"To jest już aktualna Profesja postaci.",
			));
		}

		const policy = transferPolicy(actor, current, targetCareer, exitIndex);
		assertAvailableExperience(actor, policy.cost);
		await validateTransferRestrictions(actor, current, targetCareer, policy.exit);

		const confirmed = await DialogV2.confirm({
			window: { title: localize("Change Career", "Zmiana profesji") },
			content: `<p>${escapeHtml(localize(
				`Change Career from ${current.name} to ${targetCareer.name} for ${policy.cost} Experience Points? The new Advance Scheme replaces the old one; existing Skills and purchased advances are retained. New Career Skills are not gained automatically.`,
				`Zmienić profesję z ${current.name} na ${targetCareer.name} za ${policy.cost} Punktów Doświadczenia? Nowy Schemat rozwoju zastąpi stary; posiadane Umiejętności i wykupione rozwinięcia pozostają. Umiejętności nowej Profesji nie są zdobywane automatycznie.`,
			))}</p>`,
			rejectClose: false,
			modal: true,
		});
		if (!confirmed) return null;

		const detailsBefore = cloneDetails(actor);
		const schemeBefore = characteristicCareerSnapshot(actor);
		const spentBefore = nonNegativeInteger(actor.system?.experience?.spent);
		let selected = null;
		let createdCareer = false;

		try {
			selected = await ensureEmbeddedCareer(actor, targetCareer, { initial: false });
			createdCareer = String(selected.id) !== String(targetCareer.id) ||
				String(targetCareer.parent?.uuid ?? "") !== String(actor.uuid ?? "");
			await setCurrentCareer(actor, selected, current);
			await applyAdvanceScheme(actor, selected);

			const history = Array.isArray(detailsBefore.careerHistory)
				? foundry.utils.deepClone(detailsBefore.careerHistory)
				: [];
			history.push({
				name: String(selected.name ?? ""),
				uuid: String(selected.uuid ?? ""),
				completed: false,
			});
			const details = cloneDetails(actor);
			details.currentCareer = "";
			details.careerClass = "";
			details.careerHistory = history;
			details.careerExits = careerExits(selected).map((exit) => resolvedReferenceName(exit));

			const transaction = {
				version: VERSION,
				id: foundry.utils.randomID(),
				kind: "career-transfer",
				state: "applied",
				fromCareerItemId: String(current.id ?? ""),
				toCareerItemId: String(selected.id ?? ""),
				cost: policy.cost,
				policy: policy.kind,
				spentBefore,
				spentAfter: spentBefore + policy.cost,
				userId: String(game.user?.id ?? ""),
				createdAt: Date.now(),
			};
			await actor.update({
				"system.details": details,
				"system.experience.spent": transaction.spentAfter,
				[`flags.${FLAG_SCOPE}.${CAREER_TRANSACTION_FLAG_KEY}`]: transaction,
			});
			void actor.sheet?.render?.();
			return Object.freeze({ ...transaction, career: selected });
		} catch (error) {
			await restoreCharacteristicCareerSnapshot(actor, schemeBefore).catch(() => {});
			await actor.update({
				"system.details": detailsBefore,
				"system.experience.spent": spentBefore,
			}).catch(() => {});
			if (actor.items?.has?.(current.id)) {
				await actor.updateEmbeddedDocuments("Item", [{
					_id: current.id,
					"system.current": true,
				}]).catch(() => {});
			}
			if (selected?.id && actor.items?.has?.(selected.id)) {
				if (createdCareer) {
					await actor.deleteEmbeddedDocuments("Item", [selected.id]).catch(() => {});
				} else {
					await actor.updateEmbeddedDocuments("Item", [{
						_id: selected.id,
						"system.current": false,
					}]).catch(() => {});
				}
			}
			throw error;
		}
	}

	static async transferFromExit(sheet, exitIndex) {
		const actor = sheet?.document;
		assertCharacterActor(actor);
		const exit = this.exitOffers(actor)[exitIndex];
		if (!exit) throw new Error(localize(
			"This Career Exit is no longer available.",
			"Ta Profesja wyjściowa nie jest już dostępna.",
		));
		const target = exit.uuid ? await foundry.utils.fromUuid(exit.uuid) : null;
		if (!(target instanceof foundry.documents.Item) || target.type !== "career") {
			throw new Error(localize(
				"The Career Exit does not resolve to an available Career Item.",
				"Profesja wyjściowa nie prowadzi do dostępnego Przedmiotu Profesji.",
			));
		}
		return this.transferCareer(sheet, target, { exitIndex });
	}
}

async function resolveInitialPackage(actor, career) {
	const acquisition = {
		version: VERSION,
		kind: "initial",
		careerItemId: String(career.id ?? ""),
		careerUuid: String(career.uuid ?? ""),
		createdItemIds: [],
		createdActorUuids: [],
		skills: [],
		trappings: [],
		magicPoints: null,
		createdAt: Date.now(),
	};

	for (const entry of careerEntries(career, "skills")) {
		const resolution = await resolveEntry(actor, career, entry, "skill");
		acquisition.skills.push(resolution.summary);
		if (!resolution.acquired) continue;
		for (const grant of resolution.grants) {
			const created = await createInitialSkillGrant(actor, career, grant);
			if (created?.id) acquisition.createdItemIds.push(created.id);
		}
	}

	for (const entry of careerEntries(career, "trappings")) {
		const resolution = await resolveEntry(actor, career, entry, "trapping");
		acquisition.trappings.push(resolution.summary);
		if (!resolution.acquired) continue;
		for (const grant of resolution.grants) {
			const created = await createInitialTrappingGrant(actor, career, grant);
			if (created instanceof foundry.documents.Item) {
				acquisition.createdItemIds.push(created.id);
			} else if (created instanceof foundry.documents.Actor) {
				acquisition.createdActorUuids.push(created.uuid);
			}
		}
	}

	acquisition.magicPoints = await resolveInitialMagicPoints(actor, career);
	return acquisition;
}

async function resolveEntry(actor, career, entry, kind) {
	const chance = Math.max(0, Math.min(100, nonNegativeInteger(entry?.chance)));
	let chanceRoll = null;
	let passedChance = true;
	if (chance < 100) {
		chanceRoll = await rollFormula("1d100");
		await showDice(chanceRoll);
		passedChance = Number(chanceRoll.total) <= chance;
	}

	const choices = Array.isArray(entry?.choices) ? [...entry.choices] : [];
	let selected = [];
	let choiceRoll = null;

	if (passedChance && choices.length) {
		switch (String(entry?.mode ?? CAREER_ENTRY_MODE.ALL)) {
			case CAREER_ENTRY_MODE.PLAYER_CHOICE:
				selected = await chooseEntryChoices(entry, kind);
				break;
			case CAREER_ENTRY_MODE.RANDOM_CHOICE:
				if (choices.length === 1) {
					selected = [choices[0]];
				} else {
					choiceRoll = await rollFormula(`1d${choices.length}`);
					await showDice(choiceRoll);
					selected = [choices[Math.max(0, Math.min(choices.length - 1, Number(choiceRoll.total) - 1))]];
				}
				break;
			default:
				selected = choices;
				break;
		}
	}

	const grants = selected.flatMap((choice) =>
		Array.isArray(choice?.grants) ? choice.grants.map((grant) => foundry.utils.deepClone(grant)) : [],
	);
	return {
		acquired: passedChance && selected.length > 0,
		grants,
		summary: {
			entryId: String(entry?.id ?? ""),
			kind,
			chance,
			chanceRoll: chanceRoll ? Number(chanceRoll.total) : null,
			passedChance,
			choiceRoll: choiceRoll ? Number(choiceRoll.total) : null,
			selectedChoiceIds: selected.map((choice) => String(choice?.id ?? "")),
			selectedLabels: selected.map((choice) => choiceDisplayName(choice)),
			entryNote: String(entry?.note ?? ""),
		},
	};
}

async function chooseEntryChoices(entry, kind) {
	const choices = Array.isArray(entry?.choices) ? entry.choices : [];
	if (!choices.length) return [];
	const choose = Math.max(1, Math.min(choices.length, nonNegativeInteger(entry?.choose) || 1));
	const type = choose === 1 ? "radio" : "checkbox";
	const groupName = "careerChoice";
	const choiceRows = [];
	for (const choice of choices) {
		const descriptions = [];
		for (const grant of choice.grants ?? []) {
			const source = await sourceDocument(grant);
			const description = itemDescription(source);
			if (description) descriptions.push(description);
		}
		choiceRows.push({
			id: String(choice.id ?? ""),
			label: choiceDisplayName(choice),
			description: descriptions.join("\n\n"),
		});
	}

	const content = `
		<div class="wfrp1ed career-choice-dialog">
			<p>${escapeHtml(kind === "skill"
				? localize(`Choose ${choose} Skill option${choose === 1 ? "" : "s"}.`, `Wybierz ${choose} opcję Umiejętności.`)
				: localize(`Choose ${choose} Trapping option${choose === 1 ? "" : "s"}.`, `Wybierz ${choose} opcję Wyposażenia.`))}</p>
			${choiceRows.map((choice, index) => `
				<label class="career-choice-dialog__option">
					<input type="${type}" name="${groupName}" value="${escapeHtml(choice.id)}" ${index === 0 && choose === 1 ? "checked" : ""}>
					<span><strong>${escapeHtml(choice.label)}</strong>${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}</span>
				</label>
			`).join("")}
		</div>
	`;

	const selectedIds = await DialogV2.wait({
		window: { title: localize("Career choice", "Wybór Profesji") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "choose",
			label: localize("Choose", "Wybierz"),
			default: true,
			callback: (_event, button) => {
				const selected = [...button.form.querySelectorAll(`input[name="${groupName}"]:checked`)]
					.map((input) => String(input.value));
				if (selected.length !== choose) {
					ui.notifications.warn(localize(
						`Select exactly ${choose} option${choose === 1 ? "" : "s"}.`,
						`Wybierz dokładnie ${choose} opcję/opcje.`,
					));
					return false;
				}
				return selected;
			},
		}],
	});
	if (!Array.isArray(selectedIds)) {
		throw new Error(localize(
			"Career package selection was cancelled.",
			"Anulowano wybór pakietu Profesji.",
		));
	}
	return choices.filter((choice) => selectedIds.includes(String(choice?.id ?? "")));
}

async function createInitialSkillGrant(actor, career, grant) {
	const source = await sourceDocument(grant);
	const identity = skillIdentityFromGrant(grant, source);
	if (!identity || hasSkillIdentity(actor, identity)) return null;
	const itemSource = await skillSourceForGrant(grant, source);
	markCareerGrant(itemSource, career, grant, "initial-skill");
	const created = await actor.createEmbeddedDocuments("Item", [itemSource]);
	return created[0] ?? null;
}

async function createInitialTrappingGrant(actor, career, grant) {
	const source = await sourceDocument(grant);
	if (String(grant?.documentType ?? CAREER_DOCUMENT_TYPE.ITEM) === CAREER_DOCUMENT_TYPE.ACTOR) {
		if (!(source instanceof foundry.documents.Actor) || source.type !== "creature") {
			throw new Error(localize(
				`Career Trapping '${grant?.name ?? ""}' does not resolve to a Creature Actor.`,
				`Wyposażenie Profesji '${grant?.name ?? ""}' nie prowadzi do Aktora typu Stworzenie.`,
			));
		}
		const actorSource = source.toObject();
		delete actorSource._id;
		delete actorSource.folder;
		delete actorSource.sort;
		delete actorSource._stats;
		actorSource.ownership = foundry.utils.deepClone(actor.ownership ?? {});
		actorSource.flags ??= {};
		actorSource.flags[FLAG_SCOPE] ??= {};
		actorSource.flags[FLAG_SCOPE][CAREER_COMPANION_FLAG_KEY] = {
			version: VERSION,
			ownerCharacterUuid: String(actor.uuid ?? ""),
			careerItemId: String(career.id ?? ""),
			sourceUuid: String(source.uuid ?? ""),
			createdAt: Date.now(),
		};
		return foundry.documents.Actor.create(actorSource, { renderSheet: false });
	}

	if (!(source instanceof foundry.documents.Item) || !["equipment", "weapon", "armour"].includes(source.type)) {
		throw new Error(localize(
			`Career Trapping '${grant?.name ?? ""}' does not resolve to Equipment, Weapon, or Armour.`,
			`Wyposażenie Profesji '${grant?.name ?? ""}' nie prowadzi do Ekwipunku, Broni ani Pancerza.`,
		));
	}
	const itemSource = cleanItemSource(source.toObject());
	if (itemSource.system && Object.hasOwn(itemSource.system, "quantity")) {
		itemSource.system.quantity = Math.max(1, nonNegativeInteger(grant?.quantity) || 1);
	}
	markCareerGrant(itemSource, career, grant, "initial-trapping");
	const created = await actor.createEmbeddedDocuments("Item", [itemSource]);
	return created[0] ?? null;
}

async function resolveInitialMagicPoints(actor, career) {
	const entries = Array.isArray(career.system?.magicPoints) ? career.system.magicPoints : [];
	if (!entries.length) return null;
	const race = normalizeIdentity(actor.system?.details?.race);
	const matching = entries.find((entry) => {
		const races = Array.isArray(entry?.races) ? entry.races : [];
		return races.length > 0 && races.some((candidate) => normalizeIdentity(candidate) === race);
	}) ?? entries.find((entry) => !Array.isArray(entry?.races) || entry.races.length === 0);
	if (!matching?.formula) return null;

	const before = nonNegativeInteger(actor.system?.status?.magicPoints);
	const roll = await rollFormula(String(matching.formula));
	await showDice(roll);
	const granted = nonNegativeInteger(roll.total);
	const after = before + granted;
	await actor.update({ "system.status.magicPoints": after });
	return {
		formula: String(matching.formula),
		roll: granted,
		granted,
		before,
		after,
		note: String(matching.note ?? ""),
	};
}

async function removeInitialCareerPackage(actor, career) {
	const acquisition = career.getFlag?.(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY);
	if (!isObject(acquisition) || acquisition.kind !== "initial") return;
	await rollbackAcquisition(actor, acquisition);
}

async function rollbackAcquisition(actor, acquisition) {
	const itemIds = Array.isArray(acquisition?.createdItemIds)
		? acquisition.createdItemIds.filter((id) => actor.items?.has?.(id))
		: [];
	if (itemIds.length) await actor.deleteEmbeddedDocuments("Item", itemIds);

	for (const uuid of acquisition?.createdActorUuids ?? []) {
		try {
			const companion = await foundry.utils.fromUuid(String(uuid));
			if (
				companion instanceof foundry.documents.Actor &&
				companion.getFlag?.(FLAG_SCOPE, CAREER_COMPANION_FLAG_KEY)?.ownerCharacterUuid === actor.uuid
			) {
				await companion.delete();
			}
		} catch (_error) {
			// A manually deleted companion already represents a completed cleanup.
		}
	}

	const magic = acquisition?.magicPoints;
	if (magic && nonNegativeInteger(actor.system?.status?.magicPoints) === nonNegativeInteger(magic.after)) {
		await actor.update({ "system.status.magicPoints": nonNegativeInteger(magic.before) });
	}
}

async function ensureEmbeddedCareer(actor, sourceCareer, { initial }) {
	if (String(sourceCareer.parent?.uuid ?? "") === String(actor.uuid ?? "")) {
		return sourceCareer;
	}
	const source = cleanItemSource(sourceCareer.toObject());
	source.system ??= {};
	source.system.current = false;
	source.system.complete = false;
	source.flags ??= {};
	source.flags[FLAG_SCOPE] ??= {};
	source.flags[FLAG_SCOPE][CAREER_SOURCE_FLAG_KEY] = {
		version: VERSION,
		sourceUuid: String(sourceCareer.uuid ?? ""),
		initial: initial === true,
		createdAt: Date.now(),
	};
	const created = await actor.createEmbeddedDocuments("Item", [source]);
	const career = created[0];
	if (!career) throw new Error("Foundry did not create the embedded Career Item.");
	return career;
}

async function setCurrentCareer(actor, selected, previous) {
	const updates = [];
	if (previous && String(previous.id) !== String(selected.id)) {
		updates.push({ _id: previous.id, "system.current": false });
	}
	updates.push({ _id: selected.id, "system.current": true });
	await actor.updateEmbeddedDocuments("Item", updates);
}

async function applyAdvanceScheme(actor, career) {
	const scheme = career.system?.advanceScheme ?? {};
	const update = {};
	for (const id of CHARACTERISTIC_IDS) {
		const storageKey = id === "m" && !actor.system?.characteristics?.m && actor.system?.characteristics?.sp
			? "sp"
			: id;
		if (!actor.system?.characteristics?.[storageKey]) continue;
		update[`system.characteristics.${storageKey}.career`] = nonNegativeInteger(scheme?.[id]);
	}
	if (Object.keys(update).length) await actor.update(update);
}

function characteristicCareerSnapshot(actor) {
	const snapshot = {};
	for (const id of CHARACTERISTIC_IDS) {
		const storageKey = id === "m" && !actor.system?.characteristics?.m && actor.system?.characteristics?.sp
			? "sp"
			: id;
		if (!actor.system?.characteristics?.[storageKey]) continue;
		snapshot[storageKey] = nonNegativeInteger(actor.system.characteristics[storageKey].career);
	}
	return snapshot;
}

async function restoreCharacteristicCareerSnapshot(actor, snapshot) {
	const update = {};
	for (const [storageKey, value] of Object.entries(snapshot ?? {})) {
		update[`system.characteristics.${storageKey}.career`] = nonNegativeInteger(value);
	}
	if (Object.keys(update).length) await actor.update(update);
}

function transferPolicy(actor, current, target, exitIndex) {
	const exits = CareerProgression.exitOffers(actor);
	let exit = null;
	if (Number.isInteger(exitIndex) && exitIndex >= 0) exit = exits[exitIndex] ?? null;
	if (!exit) {
		exit = exits.find((candidate) => sameCareerReference(candidate, target)) ?? null;
	}
	if (exit) return { kind: "career-exit", cost: CAREER_TRANSFER_COST, exit };

	const tier = String(target.system?.tier ?? "");
	if (tier !== CAREER_TIER.BASIC) {
		throw new Error(localize(
			"An Advanced Career may only be entered when it is listed as a Career Exit from the current Career.",
			"Profesję zaawansowaną można rozpocząć tylko wtedy, gdy jest wymieniona jako Profesja wyjściowa z aktualnej Profesji.",
		));
	}
	const sameClass = String(current.system?.class ?? "") === String(target.system?.class ?? "");
	return {
		kind: sameClass ? "basic-same-class" : "basic-cross-class",
		cost: sameClass ? CAREER_TRANSFER_COST : CROSS_CLASS_BASIC_TRANSFER_COST,
		exit: null,
	};
}

async function validateTransferRestrictions(actor, current, target, exit) {
	if (!exit) return;
	const race = normalizeIdentity(actor.system?.details?.race);
	if ((exit.excludedRaces ?? []).some((candidate) => normalizeIdentity(candidate) === race)) {
		throw new Error(localize(
			`The current Career Exit does not allow ${actor.system?.details?.race || "this race"} to enter ${target.name}.`,
			`Ta Profesja wyjściowa nie pozwala rasie ${actor.system?.details?.race || "tej postaci"} przejść do Profesji ${target.name}.`,
		));
	}
	if (exit.requiresComplete && readBoolean(current.system?.complete) !== true) {
		throw new Error(localize(
			`This Career Exit requires ${current.name} to be completed first.`,
			`Ta Profesja wyjściowa wymaga wcześniejszego ukończenia Profesji ${current.name}.`,
		));
	}
	if (exit.condition) {
		const confirmed = await DialogV2.confirm({
			window: { title: localize("Career Exit condition", "Warunek Profesji wyjściowej") },
			content: `<p>${escapeHtml(exit.condition)}</p><p>${escapeHtml(localize(
				"Confirm that the condition has been satisfied. The system will not invent a mechanical interpretation for authored narrative conditions.",
				"Potwierdź, że warunek został spełniony. System nie będzie samodzielnie interpretował opisowych warunków mechanicznie.",
			))}</p>`,
			rejectClose: false,
			modal: true,
		});
		if (!confirmed) throw new Error(localize("Career change cancelled.", "Anulowano zmianę profesji."));
	}
}

function grantForOffer(career, offer) {
	const entry = careerEntries(career, "skills").find((candidate) => String(candidate?.id ?? "") === offer.entryId);
	const choice = entry?.choices?.find((candidate) => String(candidate?.id ?? "") === offer.choiceId);
	return choice?.grants?.[offer.grantIndex] ?? null;
}

async function skillSourceForGrant(grant, source) {
	if (source instanceof foundry.documents.Item && source.type === "skill") {
		const itemSource = cleanItemSource(source.toObject());
		itemSource.system ??= {};
		if (grant?.rulesId) itemSource.system.rulesId = String(grant.rulesId);
		if (grant?.specialisation) itemSource.system.specialisation = String(grant.specialisation);
		return itemSource;
	}
	return {
		name: String(grant?.name ?? localize("Career Skill", "Umiejętność Profesji")),
		type: "skill",
		system: {
			rulesId: String(grant?.rulesId ?? ""),
			description: "",
			specialisation: String(grant?.specialisation ?? ""),
		},
	};
}

function markCareerGrant(itemSource, career, grant, kind) {
	itemSource.flags ??= {};
	itemSource.flags[FLAG_SCOPE] ??= {};
	itemSource.flags[FLAG_SCOPE][CAREER_GRANT_FLAG_KEY] = {
		version: VERSION,
		careerItemId: String(career.id ?? ""),
		careerUuid: String(career.uuid ?? ""),
		kind,
		sourceUuid: String(grant?.uuid ?? ""),
		createdAt: Date.now(),
	};
}

function careerEntries(career, field) {
	const source = career?.system?.[field];
	return Array.isArray(source) ? source : [];
}

function careerExits(career) {
	return Array.isArray(career?.system?.exits) ? career.system.exits : [];
}

function cleanItemSource(source) {
	const clean = foundry.utils.deepClone(source ?? {});
	delete clean._id;
	delete clean.folder;
	delete clean.sort;
	delete clean.ownership;
	delete clean._stats;
	return clean;
}

async function sourceDocument(grant) {
	const uuid = String(grant?.uuid ?? "");
	if (!uuid) return null;
	try {
		return await foundry.utils.fromUuid(uuid);
	} catch (_error) {
		return null;
	}
}

function sourceDocumentSync(grant) {
	const uuid = String(grant?.uuid ?? "");
	if (!uuid) return null;
	try {
		return foundry.utils.fromUuidSync(uuid);
	} catch (_error) {
		return null;
	}
}

function canonicalSkillId(item) {
	if (!(item instanceof foundry.documents.Item) || item.type !== "skill") return "";
	return String(
		item.system?.rulesId ||
		item.getFlag?.(FLAG_SCOPE, CORE_CATALOG_FLAG_KEY)?.canonicalRulesId ||
		item.getFlag?.(FLAG_SCOPE, CORE_CATALOG_FLAG_KEY)?.catalogId ||
		"",
	).trim();
}

function skillIdentityFromItem(item) {
	const canonical = canonicalSkillId(item);
	const specialisation = normalizeIdentity(item.system?.specialisation ?? item.system?.specialization);
	const base = canonical || normalizeIdentity(item.name);
	return base ? `${base}::${specialisation}` : "";
}

function skillIdentityFromGrant(grant, source) {
	const canonical = String(grant?.rulesId ?? "").trim() || canonicalSkillId(source);
	const specialisation = normalizeIdentity(
		grant?.specialisation || source?.system?.specialisation || source?.system?.specialization,
	);
	const base = canonical || normalizeIdentity(grant?.name || source?.name);
	return base ? `${base}::${specialisation}` : "";
}

function hasSkillIdentity(actor, identity) {
	if (!identity) return false;
	return [...(actor.items ?? [])].some(
		(item) => item?.type === "skill" && skillIdentityFromItem(item) === identity,
	);
}

function grantDisplayName(grant, source) {
	const name = String(source?.name ?? grant?.name ?? "").trim();
	const specialisation = String(
		grant?.specialisation || source?.system?.specialisation || source?.system?.specialization || "",
	).trim();
	return specialisation ? `${name} (${specialisation})` : name;
}

function choiceDisplayName(choice) {
	const explicit = String(choice?.label ?? "").trim();
	if (explicit) return explicit;
	return (choice?.grants ?? []).map((grant) => grantDisplayName(grant, sourceDocumentSync(grant))).filter(Boolean).join(" + ");
}

function itemDescription(source) {
	if (!(source instanceof foundry.documents.Item)) return "";
	const value = source.system?.description;
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return String(value.value ?? "").trim();
	}
	return String(value ?? "").trim();
}

function resolvedReferenceName(reference) {
	const source = sourceDocumentSync(reference);
	return String(source?.name ?? reference?.name ?? reference?.rulesId ?? "").trim();
}

function sameCareerReference(left, right) {
	const leftRules = String(left?.rulesId ?? left?.system?.rulesId ?? "").trim();
	const rightRules = String(right?.rulesId ?? right?.system?.rulesId ?? "").trim();
	if (leftRules && rightRules) return leftRules === rightRules;
	const leftSource = String(left?.uuid ?? left?.getFlag?.(FLAG_SCOPE, CAREER_SOURCE_FLAG_KEY)?.sourceUuid ?? "");
	const rightSource = String(right?.uuid ?? right?.getFlag?.(FLAG_SCOPE, CAREER_SOURCE_FLAG_KEY)?.sourceUuid ?? "");
	if (leftSource && rightSource && leftSource === rightSource) return true;
	return normalizeIdentity(left?.name) === normalizeIdentity(right?.name);
}

function classLabel(value) {
	switch (String(value ?? "")) {
		case "warrior": return localize("Warrior", "Wojownik");
		case "ranger": return localize("Ranger", "Wędrowiec");
		case "rogue": return localize("Rogue", "Łotrzyk");
		case "academic": return localize("Academic", "Uczony");
		default: return String(value ?? "");
	}
}

export function careerClassLabel(value) {
	return classLabel(value);
}

function cloneDetails(actor) {
	const systemSource = actor.system?.toObject?.() ?? foundry.utils.deepClone(actor.system ?? {});
	return foundry.utils.deepClone(systemSource.details ?? {});
}

function assertAvailableExperience(actor, cost) {
	if (nonNegativeInteger(actor.availableExperience) < cost) {
		throw new Error(localize(
			`The character needs ${cost} available Experience Points.`,
			`Postać potrzebuje ${cost} dostępnych Punktów Doświadczenia.`,
		));
	}
}

function assertCharacterActor(actor) {
	if (!(actor instanceof foundry.documents.Actor) || actor.type !== "character") {
		throw new Error("Career progression requires a Character Actor.");
	}
}

function assertCareerItem(item) {
	if (!(item instanceof foundry.documents.Item) || item.type !== "career") {
		throw new Error("Career progression requires a Career Item.");
	}
}

function assertEditableSheet(sheet) {
	if (sheet?.isEditable !== true) {
		throw new Error(localize(
			"Enable sheet editing before changing Career data.",
			"Włącz edycję karty przed zmianą danych Profesji.",
		));
	}
}

function assertActorEditable(actor) {
	if (!actor?.canUserModify?.(game.user, "update")) {
		throw new Error(localize(
			"You do not have permission to update this character.",
			"Nie masz uprawnień do modyfikacji tej postaci.",
		));
	}
}

function readBoolean(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return value.value === true;
	}
	return value === true;
}

async function rollFormula(formula) {
	return new Roll(String(formula)).evaluate({ allowInteractive: false });
}

async function showDice(roll) {
	if (!game.dice3d?.showForRoll) return;
	try {
		await game.dice3d.showForRoll(roll, game.user, true);
	} catch (_error) {
		// Dice So Nice is presentation only; the evaluated Roll remains authoritative.
	}
}

async function publishInitialCareerSummary(actor, career, acquisition) {
	const skillRows = (acquisition.skills ?? []).map((entry) => {
		const roll = entry.chanceRoll === null ? "" : ` (${entry.chanceRoll}/${entry.chance}%)`;
		const result = entry.passedChance && entry.selectedLabels?.length
			? entry.selectedLabels.join(", ")
			: localize("not acquired", "nie zdobyto");
		return `<div><strong>${escapeHtml(localize("Skill", "Umiejętność"))}:</strong> ${escapeHtml(result + roll)}</div>`;
	}).join("");
	const trappingRows = (acquisition.trappings ?? []).map((entry) => {
		const roll = entry.chanceRoll === null ? "" : ` (${entry.chanceRoll}/${entry.chance}%)`;
		const result = entry.passedChance && entry.selectedLabels?.length
			? entry.selectedLabels.join(", ")
			: localize("not acquired", "nie zdobyto");
		return `<div><strong>${escapeHtml(localize("Trapping", "Wyposażenie"))}:</strong> ${escapeHtml(result + roll)}</div>`;
	}).join("");
	const magic = acquisition.magicPoints
		? `<div><strong>${escapeHtml(localize("Magic Points", "Punkty Magii"))}:</strong> ${escapeHtml(`${acquisition.magicPoints.formula} → ${acquisition.magicPoints.granted}`)}</div>`
		: "";
	await ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content: `<section class="wfrp1ed career-acquisition-summary"><h3>${escapeHtml(`${localize("Initial Career", "Profesja początkowa")}: ${career.name}`)}</h3>${skillRows}${trappingRows}${magic}</section>`,
	});
}

function normalizeIdentity(value) {
	return String(value ?? "")
		.trim()
		.toLocaleLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function isObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

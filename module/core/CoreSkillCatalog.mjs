/**
 * Canonical WFRP 1e Core Skill catalogue.
 *
 * Mechanics authority: English Core Rulebook, Skills, printed p. 45 index and
 * pp. 46-58 descriptions. Polish labels/index positions are from the Polish
 * Core Rulebook, Umiejętności, printed p. 45 and following descriptions.
 *
 * The English edition indexes 133 Skills. The Polish edition indexes 134:
 * "Wyczucie magicznego alarmu" is an additional Polish-edition Skill with no
 * English-index counterpart. We preserve that published difference explicitly
 * instead of inventing an English-Core equivalent or silently dropping it.
 *
 * `skillId` is stable content identity. It does not mean that executable
 * mechanics are implemented for the Skill. Mechanical subsystems may use the
 * same id as a lookup key only after the relevant WFRP 1e rule has been audited.
 *
 * Skill descriptions are deliberately not copied into this source yet. The
 * supplied Core PDFs are scanned images and descriptions must be individually
 * audited before being promoted to persistent rules content.
 */

const CORE_CATALOG_VERSION = 2;

const SKILLS = Object.freeze([
	skill("acrobatics", "Acrobatics", "Akrobatyka", 1, 1),
	skill("acting", "Acting", "Aktorstwo", 2, 2),
	skill("acuteHearing", "Acute Hearing", "Czuły słuch", 3, 21),
	skill("ambidextrous", "Ambidextrous", "Oburęczność", 4, 57),
	skill("animalCare", "Animal Care", "Opieka nad zwierzętami", 5, 62),
	skill("animalTraining", "Animal Training", "Tresura", 6, 100),
	skill("arcaneLanguage", "Arcane Language", "Język tajemny", 7, 38),
	skill("art", "Art", "Sztuka", 8, 90),
	skill("astronomy", "Astronomy", "Astronomia", 9, 3),
	skill("begging", "Begging", "Żebractwo", 10, 132),
	skill("blather", "Blather", "Gadanina", 11, 28),
	skill("boatBuilding", "Boat Building", "Szkutnictwo", 12, 88),
	skill("brewing", "Brewing", "Piwowarstwo", 13, 64),
	skill("bribery", "Bribery", "Przekupstwo", 14, 70),
	skill("carpentry", "Carpentry", "Stolarstwo", 15, 84),
	skill("cartography", "Cartography", "Kartografia", 16, 41),
	skill("castSpells", "Cast Spells", "Rzucanie czarów", 17, 78),
	skill("charm", "Charm", "Urok osobisty", 18, 108),
	skill("charmAnimal", "Charm Animal", "Posłuch u zwierząt", 19, 67),
	skill("chemistry", "Chemistry", "Chemia", 20, 15),
	skill("clown", "Clown", "Błaznowanie", 21, 8),
	skill("comedian", "Comedian", "Komedianctwo", 22, 42),
	skill("concealmentRural", "Concealment Rural", "Ukrywanie się na wsi", 23, 106),
	skill("concealmentUrban", "Concealment Urban", "Ukrywanie się w mieście", 24, 105),
	skill("consumeAlcohol", "Consume Alcohol", "Mocna głowa", 25, 53),
	skill("contortionist", "Contortionist", "Człowiek-guma", 26, 20),
	skill("cook", "Cook", "Gotowanie", 27, 31),
	skill("cryptography", "Cryptography", "Kryptografia", 28, 46),
	skill("cureDisease", "Cure Disease", "Leczenie chorób", 29, 47),
	skill("dance", "Dance", "Taniec", 30, 96),
	skill("demonLore", "Demon Lore", "Wiedza o demonach", 31, 113),
	skill("disarm", "Disarm", "Rozbrajanie", 32, 71),
	skill("disguise", "Disguise", "Charakteryzacja", 33, 14),
	skill("divining", "Divining", "Wróżenie", 34, 118),
	skill("dodgeBlow", "Dodge Blow", "Uniki", 35, 107),
	skill("dowsing", "Dowsing", "Różdżkarstwo", 36, 76),
	skill("driveCart", "Drive Cart", "Powożenie", 37, 68),
	skill("embezzling", "Embezzling", "Defraudacja", 38, 24),
	skill("engineer", "Engineer", "Inżynieria", 39, 36),
	skill("escapology", "Escapology", "Wyzwalanie się z więzów", 40, 126),
	skill("etiquette", "Etiquette", "Etykieta", 41, 26),
	skill("evaluate", "Evaluate", "Szacowanie", 42, 85),
	skill("excellentVision", "Excellent Vision", "Bystry wzrok", 43, 11),
	skill("fireEating", "Fire Eating", "Połykanie ognia", 44, 66),
	skill("fish", "Fish", "Rybactwo", 45, 77),
	skill("flee", "Flee!", "Ucieczka", 46, 104),
	skill("fleetFooted", "Fleet Footed", "Bardzo szybki", 47, 5),
	skill("followTrail", "Follow Trail", "Tropienie", 48, 101),
	skill("frenziedAttack", "Frenzied Attack", "Szaleńczy atak", 49, 86),
	skill("gamble", "Gamble", "Szulerstwo", 50, 91),
	skill("gameHunting", "Game Hunting", "Łowiectwo", 51, 49),
	skill("gemCutting", "Gem Cutting", "Jubilerstwo", 52, 39),
	skill("haggle", "Haggle", "Targowanie się", 53, 97),
	skill("healWounds", "Heal Wounds", "Leczenie ran", 54, 48),
	skill("heraldry", "Heraldry", "Heraldyka", 55, 33),
	skill("herbLore", "Herb Lore", "Zielarstwo", 56, 129),
	skill("history", "History", "Historia", 57, 35),
	skill("hypnotise", "Hypnotise", "Hipnoza", 58, 34),
	skill("identifyMagicalArtifact", "Identify Magical Artifact", "Rozpoznawanie magicznych przedmiotów", 59, 72),
	skill("identifyPlant", "Identify Plant", "Rozpoznawanie roślin", 60, 74),
	skill("identifyUndead", "Identify Undead", "Rozpoznawanie ożywieńców", 61, 73),
	skill("immunityToDisease", "Immunity to Disease", "Odporność na choroby", 62, 58),
	skill("immunityToPoison", "Immunity to Poison", "Odporność na trucizny", 63, 59),
	skill("jester", "Jest", "Szyderstwo", 64, 93),
	skill("juggle", "Juggle", "Żonglerka", 65, 134),
	skill("law", "Law", "Prawo", 66, 69),
	skill("lightningReflexes", "Lightning Reflexes", "Szybki refleks", 67, 92),
	skill("linguistics", "Linguistics", "Uzdolnienia językowe", 68, 110),
	skill("lipReading", "Lip Reading", "Czytanie z warg", 69, 22),
	skill("luck", "Luck", "Szczęście", 70, 87),
	skill("magicalAwareness", "Magical Awareness", "Wykrywanie istot magicznych", 71, 122),
	skill("magicalSense", "Magical Sense", "Wykrywanie magii", 72, 123),
	skill("manufactureDrugs", "Manufacture Drugs", "Farmacja", 73, 27),
	skill("manufactureMagicItems", "Manufacture Magic Items", "Tworzenie magicznych przedmiotów", 74, 103),
	skill("manufacturePotions", "Manufacture Potions", "Wytwarzanie eliksirów", 75, 125),
	skill("manufactureScrolls", "Manufacture Scrolls", "Tworzenie magicznych pergaminów", 76, 102),
	skill("marksmanship", "Marksmanship", "Celne strzelanie", 77, 12),
	skill("meditation", "Meditation", "Medytacja", 78, 50),
	skill("metallurgy", "Metallurgy", "Metalurgia", 79, 51),
	skill("mime", "Mime", "Mimika", 80, 52),
	skill("mimic", "Mimic", "Naśladownictwo", 81, 56),
	skill("mining", "Mining", "Górnictwo", 82, 32),
	skill("musicianship", "Musicianship", "Muzykalność", 83, 55),
	skill("nightVision", "Night Vision", "Widzenie w ciemnościach", 84, 112),
	skill("numismatics", "Numismatics", "Monetoznawstwo", 85, 54),
	skill("orientation", "Orientation", "Wyczucie kierunku", 86, 120),
	skill("palmistry", "Palmistry", "Chiromancja", 87, 16),
	skill("palmObject", "Palm Object", "Zwinne palce", 88, 131),
	skill("pickLock", "Pick Lock", "Otwieranie zamków", 89, 63),
	skill("pickPocket", "Pick Pocket", "Doliniarstwo", 90, 25),
	skill("preparePoisons", "Prepare Poisons", "Warzenie trucizn", 91, 111),
	skill("publicSpeaking", "Public Speaking", "Krasomówstwo", 92, 44),
	skill("readWrite", "Read/Write", "Czytanie/pisanie", 93, 23),
	skill("ride", "Ride", "Jeździectwo", 94, 37),
	skill("riverLore", "River Lore", "Wiedza o rzekach", 95, 115),
	skill("row", "Row", "Wiosłowanie", 96, 116),
	skill("runeLore", "Rune Lore", "Rozpoznawanie runów", 97, 75),
	skill("runeMastery", "Rune Mastery", "Opanowanie runów", 98, 61),
	skill("sailing", "Sailing", "Żeglowanie", 99, 133),
	skill("scaleSheerSurface", "Scale Sheer Surface", "Wspinaczka", 100, 119),
	skill("scrollLore", "Scroll Lore", "Wiedza o magicznych pergaminach", 101, 114),
	skill("secretLanguage", "Secret Language", "Sekretny język", 102, 80),
	skill("secretSigns", "Secret Signs", "Sekretne znaki", 103, 79),
	skill("seduction", "Seduction", "Uwodzenie", 104, 109),
	skill("setTrap", "Set Trap", "Zastawianie pułapek", 105, 128),
	skill("shadowing", "Shadowing", "Śledzenie", 106, 94),
	skill("silentMoveRural", "Silent Move Rural", "Cichy chód na wsi", 107, 19),
	skill("silentMoveUrban", "Silent Move Urban", "Cichy chód w mieście", 108, 18),
	skill("sing", "Sing", "Śpiew", 109, 95),
	skill("sixthSense", "Sixth Sense", "Szósty zmysł", 110, 89),
	skill("smithing", "Smithing", "Kowalstwo", 111, 43),
	skill("speakAdditionalLanguage", "Speak Additional Language", "Znajomość języka obcego", 112, 130),
	skill("specialistWeapon", "Specialist Weapon", "Specjalna broń", 113, 83),
	skill("spotTraps", "Spot Traps", "Wykrywanie pułapek", 114, 124),
	skill("stoneworking", "Stoneworking", "Kamieniarstwo", 115, 40),
	skill("storyTelling", "Story Telling", "Gawędziarstwo", 116, 29),
	skill("streetFighter", "Street Fighter", "Bijatyka", 117, 7),
	skill("strikeMightyBlow", "Strike Mighty Blow", "Silny cios", 118, 82),
	skill("strikeToInjure", "Strike to Injure", "Celny cios", 119, 13),
	skill("strikeToStun", "Strike to Stun", "Ogłuszenie", 120, 60),
	skill("strongman", "Strongman", "Siłacz", 121, 81),
	skill("superNumerate", "Super Numerate", "Geniusz arytmetyczny", 122, 30),
	skill("surgery", "Surgery", "Chirurgia", 123, 17),
	skill("swim", "Swim", "Pływanie", 124, 65),
	skill("tailor", "Tailor", "Krawiectwo", 125, 45),
	skill("theology", "Theology", "Teologia", 126, 98),
	skill("torture", "Torture", "Torturowanie", 127, 99),
	skill("trickRiding", "Trick Riding", "Woltyżerka", 128, 117),
	skill("ventriloquism", "Ventriloquism", "Brzuchomówstwo", 129, 10),
	skill("veryResilient", "Very Resilient", "Bardzo wytrzymały", 130, 6),
	skill("veryStrong", "Very Strong", "Bardzo silny", 131, 4),
	skill("wit", "Wit", "Błyskotliwość", 132, 9),
	skill("wrestling", "Wrestling", "Zapasy", 133, 127),
]);

const POLISH_ONLY_SKILLS = Object.freeze([
	Object.freeze({
		catalogId: "polishSenseMagicAlarm",
		skillId: "polishSenseMagicAlarm",
		englishName: "",
		polishName: "Wyczucie magicznego alarmu",
		englishIndex: 0,
		polishIndex: 121,
		polishOnly: true,
	}),
]);

/**
 * Skill ids already consumed by executable system mechanics.
 *
 * This is descriptive catalogue metadata only. Presence in this set does not
 * change what `skillId` means: every Core Skill has a stable identity whether
 * or not we currently automate any part of its rules.
 */
export const IMPLEMENTED_CORE_SKILL_IDS = Object.freeze(new Set([
	"acrobatics",
	"acting",
	"acuteHearing",
	"ambidextrous",
	"animalTraining",
	"art",
	"boatBuilding",
	"bribery",
	"carpentry",
	"charm",
	"clown",
	"comedian",
	"concealmentRural",
	"concealmentUrban",
	"contortionist",
	"dance",
	"dodgeBlow",
	"engineer",
	"escapology",
	"etiquette",
	"evaluate",
	"fireEating",
	"followTrail",
	"gamble",
	"haggle",
	"immunityToDisease",
	"immunityToPoison",
	"jester",
	"juggle",
	"linguistics",
	"luck",
	"mimic",
	"mining",
	"musicianship",
	"palmistry",
	"pickLock",
	"pickPocket",
	"publicSpeaking",
	"ride",
	"scaleSheerSurface",
	"seduction",
	"shadowing",
	"silentMoveRural",
	"silentMoveUrban",
	"sing",
	"smithing",
	"specialistWeapon",
	"stoneworking",
	"storyTelling",
	"strongman",
	"superNumerate",
	"swim",
	"tailor",
	"torture",
	"trickRiding",
	"wit"
]));

export function coreSkillDefinitions(language = "en") {
	const lang = normalizeLanguage(language);
	const records = lang === "pl"
		? [...SKILLS, ...POLISH_ONLY_SKILLS]
		: [...SKILLS];

	return Object.freeze(records.map((entry) => Object.freeze({
		...entry,
		name: lang === "pl" ? entry.polishName : entry.englishName,
	})));
}

/**
 * Resolve one canonical Core Skill definition by stable Skill id.
 *
 * Polish-only content is resolvable in either UI language so existing documents
 * never lose their identity merely because the client language changes.
 */
export function coreSkillDefinition(skillId, language = "en") {
	const id = String(skillId ?? "").trim();
	if (!id) return null;

	const all = [...SKILLS, ...POLISH_ONLY_SKILLS];
	const entry = all.find((candidate) => candidate.skillId === id);
	if (!entry) return null;

	const lang = normalizeLanguage(language);
	return Object.freeze({
		...entry,
		name: lang === "pl"
			? entry.polishName
			: entry.englishName || entry.polishName,
	});
}

/** Build raw Item sources suitable for Foundry compendium packing. */
export function coreSkillItemSources(language = "en") {
	const lang = normalizeLanguage(language);

	return Object.freeze(coreSkillDefinitions(lang).map((entry) =>
		Object.freeze({
			name: entry.name,
			type: "skill",
			img: "icons/svg/book.svg",
			system: {
				skillId: entry.skillId,
				description: "",
				specialisation: "",
			},
			effects: [],
			flags: {
				wfrp1ed: {
					coreCatalog: {
						version: CORE_CATALOG_VERSION,
						kind: "skill",
						catalogId: entry.catalogId,
						skillId: entry.skillId,
						mechanicsLinked:
							IMPLEMENTED_CORE_SKILL_IDS.has(entry.skillId),
						englishName: entry.englishName,
						polishName: entry.polishName,
						englishIndex: entry.englishIndex,
						polishIndex: entry.polishIndex,
						polishOnly: entry.polishOnly === true,
						descriptionStatus: "pending-individual-audit",
						source: {
							english:
								"Core Skills index p. 45; descriptions pp. 46-58",
							polish:
								"Core Umiejętności index p. 45; descriptions pp. 46-58",
						},
					},
				},
			},
		}),
	));
}

function skill(skillId, englishName, polishName, englishIndex, polishIndex) {
	return Object.freeze({
		catalogId: skillId,
		skillId,
		englishName,
		polishName,
		englishIndex,
		polishIndex,
		polishOnly: false,
	});
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl")
		? "pl"
		: "en";
}

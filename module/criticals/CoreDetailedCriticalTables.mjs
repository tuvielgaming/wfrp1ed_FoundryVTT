import {
	CRITICAL_TABLE_ROLE,
	CRITICAL_TABLE_VARIANT,
	CRITICAL_VALUE_VARIANTS,
} from "./CriticalTableRegistry.mjs";

export const CORE_DETAILED_CHART_PROVIDER_ID =
	"wfrp1ed.core.detailed.chart";
export const CORE_DETAILED_CRITICAL_TABLE_VERSION = 1;

export const DETAILED_CRITICAL_OUTCOME = Object.freeze({
	KILLED: "killed",
});

const MAINTENANCE_OPTION = "wfrp1edCoreDetailedCriticalMaintenance";
const FLAG_SCOPE = "wfrp1ed";
const TABLE_FLAG_KEY = "coreDetailedCriticalTable";
const CHART_RESULT_FLAG_KEY = "detailedCriticalChart";
const EFFECT_RESULT_FLAG_KEY = "detailedCriticalEffect";

const CHART_TABLE_IDS = Object.freeze({
	"1": "wfrpCritDCH00001",
	"2": "wfrpCritDCH00002",
	"3": "wfrpCritDCH00003",
	"4": "wfrpCritDCH00004",
	"5": "wfrpCritDCH00005",
	"6+": "wfrpCritDCH00006",
});

const EFFECT_TABLES = Object.freeze({
	arm: Object.freeze({
		role: CRITICAL_TABLE_ROLE.DETAILED_ARM,
		providerId: "wfrp1ed.core.detailed.arm",
		id: "wfrpCritDEA00001",
	}),
	head: Object.freeze({
		role: CRITICAL_TABLE_ROLE.DETAILED_HEAD,
		providerId: "wfrp1ed.core.detailed.head",
		id: "wfrpCritDEH00001",
	}),
	body: Object.freeze({
		role: CRITICAL_TABLE_ROLE.DETAILED_BODY,
		providerId: "wfrp1ed.core.detailed.body",
		id: "wfrpCritDEB00001",
	}),
	leg: Object.freeze({
		role: CRITICAL_TABLE_ROLE.DETAILED_LEG,
		providerId: "wfrp1ed.core.detailed.leg",
		id: "wfrpCritDEL00001",
	}),
});

const MANAGED_TABLE_IDS = new Set([
	...Object.values(CHART_TABLE_IDS),
	...Object.values(EFFECT_TABLES).map((entry) => entry.id),
]);

export const CORE_DETAILED_CHART_TABLE_UUIDS = Object.freeze(
	Object.fromEntries(
		Object.entries(CHART_TABLE_IDS).map(([variant, id]) => [
			variant,
			`RollTable.${id}`,
		]),
	),
);

export const CORE_DETAILED_EFFECT_PROVIDERS = Object.freeze(
	Object.fromEntries(
		Object.values(EFFECT_TABLES).map((entry) => [
			entry.role,
			Object.freeze({
				id: entry.providerId,
				tableUuids: Object.freeze({
					[CRITICAL_TABLE_VARIANT.DEFAULT]: `RollTable.${entry.id}`,
				}),
			}),
		]),
	),
);

const PRESENTATION = Object.freeze({
	en: Object.freeze({
		chartName: (variant) => `WFRP1ED Core — Critical Hit Chart +${variant}`,
		effectName: (location) =>
			`WFRP1ED Core — Critical Effects — ${locationLabel(location, "en")}`,
		chartDescription:
			"System-managed WFRP 1e Core fallback. Combat, printed p. 122. The d100 result selects a numbered Critical Effect for the appropriate hit location.",
		effectDescription:
			"System-managed WFRP 1e Core fallback. Combat, printed pp. 122-124. Results are looked up by the effect number produced by the Critical Hit Chart.",
		protectedWarning:
			"This is a system-managed WFRP 1e Core detailed-critical table. Duplicate it and configure the copy as an override for house rules.",
		effect: "Effect",
		flee: "— victim must flee combat if possible",
	}),
	pl: Object.freeze({
		chartName: (variant) => `WFRP1ED Core — Tabela trafień krytycznych +${variant}`,
		effectName: (location) =>
			`WFRP1ED Core — Efekty trafień krytycznych — ${locationLabel(location, "pl")}`,
		chartDescription:
			"Zarządzana przez system domyślna tabela WFRP 1e Core. Walka, str. 122. Rzut K100 wskazuje numer efektu krytycznego dla odpowiedniego obszaru trafienia.",
		effectDescription:
			"Zarządzana przez system domyślna tabela WFRP 1e Core. Walka, str. 122-124. Wynik jest odczytywany według numeru efektu wskazanego przez Tabelę trafień krytycznych.",
		protectedWarning:
			"To jest zarządzana przez system tabela szczegółowych trafień krytycznych WFRP 1e Core. Utwórz kopię i ustaw ją jako nadpisanie, aby użyć zasad własnych.",
		effect: "Efekt",
		flee: "— ofiara musi uciekać z walki, jeśli jest to możliwe",
	}),
});

/*
 * Audited against the user-supplied WFRP 1e Core Rulebooks.
 *
 * English: Combat — Critical Hits / Critical Hit Chart / Critical Effects,
 * printed pp. 122-124.
 * Polish: Walka — Trafienia krytyczne / Tabela trafień krytycznych /
 * Efekty trafień krytycznych, printed pp. 122-124.
 *
 * The chart and numbered consequences agree mechanically. English starred
 * chart entries and Polish starred entries both require the victim to flee
 * combat if possible.
 */
const DETAILED_CHART_BANDS = Object.freeze([
	chartBand(1, 10, [1, 3, 5, 7, star(11), star(14)]),
	chartBand(11, 20, [2, 4, 6, star(9), star(13), 15]),
	chartBand(21, 30, [3, 5, star(8), star(14), 16, 16]),
	chartBand(31, 40, [4, 7, star(10), star(13), 15, 15]),
	chartBand(41, 50, [5, star(9), star(14), 16, 16, 16]),
	chartBand(51, 60, [7, star(12), 15, 15, 15, 15]),
	chartBand(61, 70, [star(9), 16, 16, 16, 16, 16]),
	chartBand(71, 80, [star(11), 15, 15, 15, 15, 15]),
	chartBand(81, 90, [16, 16, 16, 16, 16, 16]),
	chartBand(91, 100, [15, 15, 15, 15, 15, 15]),
]);

const EFFECTS = deepFreeze({
	arm: [
		effect("The arm is pulled clear, but anything held in that hand is dropped.", "Ręka zostaje cofnięta, ale postać upuszcza wszystko, co trzyma w tej dłoni."),
		effect("Painful knuckle injury; the arm remains usable, but anything held in that hand is dropped.", "Bolesne uderzenie w kostki; ręka pozostaje sprawna, ale postać upuszcza wszystko z tej dłoni."),
		effect("The hand is incapacitated until the end of the next round; anything held is dropped.", "Dłoń jest niesprawna do końca następnej rundy; wszystkie trzymane przedmioty zostają upuszczone."),
		effect("The wrist is dislocated. Anything held is dropped and the hand is incapacitated until medical attention is received.", "Nadgarstek zostaje zwichnięty. Wszystkie trzymane przedmioty zostają upuszczone, a dłoń jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("The fingers are shattered. Anything held is dropped and the hand is incapacitated until medical attention is received.", "Palce zostają zmiażdżone. Wszystkie trzymane przedmioty zostają upuszczone, a dłoń jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("A held object, usually a weapon or shield, is destroyed. The limb is numb and incapacitated for D6 rounds.", "Trzymany przedmiot, zwykle broń lub tarcza, zostaje zniszczony. Kończyna jest zdrętwiała i niesprawna przez K6 rund."),
		effect("The shoulder is dislocated. The arm is incapacitated until medical attention is received.", "Bark zostaje zwichnięty. Ręka jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("A deep wound cuts muscle and tendon. Anything held is dropped and the arm is incapacitated until medical attention is received.", "Głęboka rana przecina mięśnie i ścięgna. Wszystkie trzymane przedmioty zostają upuszczone, a ręka jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("The forearm bones are smashed. Anything held is dropped and the arm below the elbow is incapacitated until medical attention is received.", "Kości przedramienia zostają zmiażdżone. Wszystkie trzymane przedmioty zostają upuszczone, a ręka poniżej łokcia jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("The upper arm is smashed. Anything held is dropped and the arm is incapacitated until medical attention is received.", "Kość ramienia zostaje zmiażdżona. Wszystkie trzymane przedmioty zostają upuszczone, a ręka jest niesprawna do czasu otrzymania pomocy medycznej."),
		effect("The arm is smashed and an artery is severed. Anything held is dropped; the arm is incapacitated until medical attention. Lose 1 Wound per round until medical attention; all further criticals use Sudden Death.", "Ręka zostaje zmiażdżona i przecięta zostaje tętnica. Wszystkie trzymane przedmioty zostają upuszczone; ręka jest niesprawna do czasu pomocy medycznej. Postać traci 1 punkt Żywotności na rundę; kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The hand is mangled and effectively lost at the wrist. Anything held is lost; the victim falls unconscious and loses D4 Wounds per round until medical attention. All further criticals use Sudden Death.", "Dłoń zostaje zmasakrowana i utracona przy nadgarstku. Wszystko trzymane zostaje utracone; postać traci przytomność i K4 punktów Żywotności na rundę do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The arm is torn off at the elbow. The victim collapses and can do nothing until medical attention, losing D4 Wounds per round. All further criticals use Sudden Death.", "Ręka zostaje oderwana w łokciu. Postać pada i nie może nic robić do czasu pomocy medycznej, tracąc K4 punktów Żywotności na rundę. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The arm is torn off at the shoulder. The victim collapses and can do nothing until medical attention, losing D6 Wounds per round. All further criticals use Sudden Death.", "Ręka zostaje oderwana w barku. Postać pada i nie może nic robić do czasu pomocy medycznej, tracąc K6 punktów Żywotności na rundę. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The shoulder joint is almost completely destroyed and a major artery is severed. Death from shock and blood loss is almost instantaneous.", "Staw barkowy zostaje niemal całkowicie zniszczony, a główna tętnica przerwana. Śmierć wskutek szoku i utraty krwi następuje niemal natychmiast.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The blow smashes through the arm into the chest, destroying the arm and causing catastrophic blood loss. The victim dies almost instantly.", "Cios przebija rękę i klatkę piersiową, niszcząc rękę i powodując katastrofalny krwotok. Postać umiera niemal natychmiast.", DETAILED_CRITICAL_OUTCOME.KILLED),
	],
	head: [
		effect("The tip of one ear is torn off. No attacks may be made next round, but parries are allowed; combat then proceeds normally.", "Czubek jednego ucha zostaje odcięty. W następnej rundzie postać nie może atakować, ale może parować; potem walczy normalnie."),
		effect("A glancing blow stuns the victim; next round they may do nothing except parry.", "Draśnięcie ogłusza postać; w następnej rundzie może jedynie parować."),
		effect("The victim is stunned and may do nothing except parry for the next D4 rounds.", "Postać jest ogłuszona i przez następne K4 rundy może jedynie parować."),
		effect("The victim is dazed and may do nothing at all for the next round.", "Postać jest oszołomiona i w następnej rundzie nie może nic robić."),
		effect("The victim is dazed and may do nothing at all for the next D4 rounds.", "Postać jest oszołomiona i przez następne K4 rundy nie może nic robić."),
		effect("The victim is knocked down and dazed, counts as prone for the next round, and may do nothing except parry for the next D4 rounds while getting upright.", "Postać zostaje powalona i oszołomiona, w następnej rundzie jest traktowana jak leżąca i przez K4 rundy może jedynie parować podczas podnoszenia się."),
		effect("A scalp wound bleeds heavily. The victim suffers -10 to hit until medical attention is received.", "Rana skóry głowy silnie krwawi. Do czasu otrzymania pomocy medycznej postać otrzymuje -10 do trafienia."),
		effect("The jaw is broken and several teeth are lost. Next round only parries are possible; thereafter attacks suffer -10 until medical attention.", "Szczęka zostaje złamana i postać traci kilka zębów. W następnej rundzie może jedynie parować; później wszystkie ataki mają -10 do czasu pomocy medycznej."),
		effect("One eye is destroyed. The victim may do nothing next round; attacks suffer -10 until medical attention. Sight-related skills are lost and Ballistic Skill is reduced by 20, to a minimum of 5.", "Jedno oko zostaje zniszczone. W następnej rundzie postać nie może nic robić; ataki mają -10 do czasu pomocy medycznej. Zdolności zależne od wzroku zostają utracone, a Umiejętności Strzeleckie spadają o 20, nie mniej niż do 5."),
		effect("Concussion: the victim may do nothing for D4 hours or until medical attention is obtained.", "Wstrząśnienie mózgu: postać nie może nic robić przez K4 godziny lub do czasu otrzymania pomocy medycznej."),
		effect("Severe concussion: the victim may do nothing for D10 hours or until medical attention and must test Toughness or lose 10 from every percentage characteristic from lasting brain damage.", "Ciężkie wstrząśnienie mózgu: postać nie może nic robić przez K10 godzin lub do czasu pomocy medycznej i musi zdać test Wytrzymałości, inaczej traci 10 punktów z każdej cechy procentowej wskutek trwałego uszkodzenia mózgu."),
		effect("The carotid artery is ruptured. The victim collapses and bleeds to death in D4 rounds unless medical attention is received.", "Tętnica szyjna zostaje przerwana. Postać pada i wykrwawia się na śmierć w K4 rundy, jeśli nie otrzyma pomocy medycznej."),
		effect("The jawbone is driven into the lower brain. The victim collapses and dies in D6 rounds unless medical attention is received; if saved, test Toughness or lose 10 from every percentage characteristic from lasting brain damage.", "Kość szczęki zostaje wbita w dolną część mózgu. Postać pada i umrze w K6 rund, jeśli nie otrzyma pomocy medycznej; po uratowaniu musi zdać test Wytrzymałości, inaczej traci 10 punktów z każdej cechy procentowej wskutek trwałego uszkodzenia mózgu."),
		effect("The neck vertebrae are smashed. The victim falls, convulses briefly, and dies.", "Kręgi szyjne zostają zniszczone. Postać pada, drga przez kilka sekund i umiera.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The skull is shattered. Death is instantaneous.", "Czaszka zostaje roztrzaskana. Śmierć jest natychmiastowa.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The head is severed and flies away. Death is immediate.", "Głowa zostaje odcięta i odlatuje. Śmierć jest natychmiastowa.", DETAILED_CRITICAL_OUTCOME.KILLED),
	],
	body: [
		effect("A chest impact leaves the victim winded; next round they may do nothing except parry.", "Uderzenie w klatkę piersiową pozbawia tchu; w następnej rundzie postać może jedynie parować."),
		effect("A groin hit doubles the victim over in agony; they may do nothing at all next round.", "Uderzenie w krocze zgina postać z bólu; w następnej rundzie nie może nic robić."),
		effect("The victim is knocked to the ground and may only parry for the next D4 rounds until upright.", "Postać zostaje powalona i przez następne K4 rundy może jedynie parować, dopóki nie wstanie."),
		effect("A groin hit knocks the victim down and makes them drop hand-held objects; until upright they may only parry with a shield for the next D4 rounds.", "Uderzenie w krocze powala postać i powoduje upuszczenie trzymanych przedmiotów; przez K4 rundy, do czasu wstania, może jedynie parować tarczą."),
		effect("The victim is hurled to the ground, stunned for D4 rounds and treated as prone; after that they may only parry for another D4 rounds until upright.", "Postać zostaje rzucona na ziemię, jest ogłuszona przez K4 rundy i traktowana jak leżąca; następnie przez kolejne K4 rundy może jedynie parować, dopóki nie wstanie."),
		effect("Several ribs are smashed. The victim may do nothing next round and suffers -10 to attacks until medical attention.", "Kilka żeber zostaje złamanych. W następnej rundzie postać nie może nic robić, a do czasu pomocy medycznej wszystkie ataki mają -10."),
		effect("The collar-bone is smashed. All characteristics are reduced by 1 or 10 points as appropriate until medical attention is received.", "Obojczyk zostaje złamany. Wszystkie cechy są obniżone o 1 lub 10 punktów, zależnie od rodzaju cechy, do czasu pomocy medycznej."),
		effect("The hip is fractured. All characteristics are reduced by 1 or 10 as appropriate and Movement is halved until medical attention; test Initiative each round or fall. Movement-based skills are unavailable until medical attention.", "Biodro zostaje złamane. Wszystkie cechy spadają o 1 lub 10 punktów, a Szybkość jest zmniejszona o połowę do czasu pomocy medycznej; co rundę należy zdać test Inicjatywy albo upaść. Umiejętności ruchowe są niedostępne do czasu pomocy medycznej."),
		effect("A severe abdominal injury causes unconsciousness and internal bleeding: lose 1 Wound per round until medical attention.", "Poważna rana brzucha powoduje utratę przytomności i krwotok wewnętrzny: postać traci 1 punkt Żywotności na rundę do czasu pomocy medycznej."),
		effect("Shattered ribs drive bone into a lung. The victim collapses unconscious and loses D4 Wounds per round until medical attention; even after treatment they are totally incapacitated for at least 10 weeks and permanently lose 1 Toughness.", "Odłamki żeber przebijają płuco. Postać pada nieprzytomna i traci K4 punktów Żywotności na rundę do czasu pomocy medycznej; nawet po leczeniu jest całkowicie niesprawna przez co najmniej 10 tygodni i trwale traci 1 punkt Wytrzymałości."),
		effect("Severe abdominal internal injuries cause collapse and extreme pain. The victim may only parry and must test Toughness each round or pass out. After medical attention, Movement is half cautious rate and all characteristics are halved for 3D6 weeks; movement-related skills are lost until full recovery.", "Ciężkie obrażenia wewnętrzne brzucha powodują upadek i skrajny ból. Postać może jedynie parować i co rundę musi zdać test Wytrzymałości, inaczej traci przytomność. Po pomocy medycznej porusza się z połową ostrożnej szybkości, wszystkie cechy są o połowę mniejsze przez 3K6 tygodni, a umiejętności ruchowe są utracone do pełnego wyzdrowienia."),
		effect("The spine is damaged. The victim is knocked down and can do nothing until medical attention, then must test Toughness or be permanently paralysed from the waist down.", "Kręgosłup zostaje uszkodzony. Postać zostaje powalona i nie może nic robić do czasu pomocy medycznej, po czym musi zdać test Wytrzymałości, inaczej zostaje trwale sparaliżowana od pasa w dół."),
		effect("The pelvis is shattered. The victim falls and may only parry; all characteristics are halved and D4 Wounds are lost per round through internal bleeding until medical attention. Recovery takes 10 weeks and movement-related skills are lost until full recovery.", "Miednica zostaje roztrzaskana. Postać pada i może jedynie parować; wszystkie cechy są o połowę mniejsze, a krwotok wewnętrzny powoduje utratę K4 punktów Żywotności na rundę do czasu pomocy medycznej. Powrót do zdrowia trwa 10 tygodni, a umiejętności ruchowe są utracone do pełnego wyzdrowienia."),
		effect("The chest caves in and several internal organs rupture. Death follows within seconds.", "Klatka piersiowa zostaje zmiażdżona, a kilka narządów wewnętrznych pęka. Śmierć następuje w ciągu kilku sekund.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The abdominal cavity ruptures. Death is instantaneous.", "Jama brzuszna pęka. Śmierć jest natychmiastowa.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The spine and abdomen are catastrophically destroyed, tearing the body apart. Death is immediate.", "Kręgosłup i brzuch zostają katastrofalnie zniszczone, rozrywając ciało. Śmierć jest natychmiastowa.", DETAILED_CRITICAL_OUTCOME.KILLED),
	],
	leg: [
		effect("A glancing calf hit makes the victim stumble and drop any hand-held object unless a Dexterity test succeeds.", "Draśnięcie łydki powoduje potknięcie; postać upuszcza trzymane przedmioty, jeśli nie zda testu Zręczności."),
		effect("The victim is tripped and may only parry during the next round.", "Postać zostaje podcięta i w następnej rundzie może jedynie parować."),
		effect("The victim is knocked down and drops hand-held objects unless a Dexterity test succeeds; they may only parry for the next D4 rounds until upright and armed.", "Postać zostaje powalona i upuszcza trzymane przedmioty, jeśli nie zda testu Zręczności; przez K4 rundy może jedynie parować, dopóki nie wstanie i nie ma broni lub tarczy."),
		effect("The leg is numbed. Movement and Initiative are halved for D4 rounds.", "Noga drętwieje. Szybkość i Inicjatywa są zmniejszone o połowę przez K4 rundy."),
		effect("The ankle is dislocated. Movement and Initiative are halved until medical attention; fail an Initiative test and the victim is knocked down.", "Kostka zostaje zwichnięta. Szybkość i Inicjatywa są zmniejszone o połowę do czasu pomocy medycznej; nieudany test Inicjatywy powoduje powalenie."),
		effect("The hip is dislocated. Movement and Initiative are halved until medical attention; the victim must pass a test on half Initiative or be knocked down.", "Biodro zostaje zwichnięte. Szybkość i Inicjatywa są zmniejszone o połowę do czasu pomocy medycznej; postać musi zdać test na połowę Inicjatywy, inaczej zostaje powalona."),
		effect("The shin bones are shattered. The victim is knocked down; Movement and Initiative are halved until medical attention.", "Kości podudzia zostają roztrzaskane. Postać zostaje powalona; Szybkość i Inicjatywa są zmniejszone o połowę do czasu pomocy medycznej."),
		effect("A deep leg wound cuts muscle and tendon. The victim is knocked down and loses 1 Wound per round from heavy bleeding until medical attention. All further criticals use Sudden Death.", "Głęboka rana nogi przecina mięśnie i ścięgna. Postać zostaje powalona i traci 1 punkt Żywotności na rundę wskutek silnego krwawienia do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The thigh is smashed and an artery severed. The victim falls and can only rise after a successful Initiative test; lose 1 Wound per round until medical attention. All further criticals use Sudden Death.", "Udo zostaje zmiażdżone i przecięta zostaje tętnica. Postać pada i może wstać dopiero po udanym teście Inicjatywy; traci 1 punkt Żywotności na rundę do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The hip socket is smashed. Anything held is dropped; lose D4 Wounds per round until medical attention. All further criticals use Sudden Death; standing or walking requires support from another character.", "Panewka biodrowa zostaje zmiażdżona. Wszystkie trzymane przedmioty zostają upuszczone; postać traci K4 punktów Żywotności na rundę do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci; stanie i chodzenie wymaga podparcia przez inną postać."),
		effect("The ankle is mangled. The victim falls unconscious and loses D4 Wounds per round until medical attention. All further criticals use Sudden Death.", "Kostka zostaje zmasakrowana. Postać traci przytomność i K4 punktów Żywotności na rundę do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The leg is torn off at the knee. The victim collapses and can do nothing until medical attention, losing D4 Wounds per round. All further criticals use Sudden Death.", "Noga zostaje oderwana w kolanie. Postać pada i nie może nic robić do czasu pomocy medycznej, tracąc K4 punktów Żywotności na rundę. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The pelvis is shattered. The victim falls; all characteristics are halved and D4 Wounds are lost per round through internal bleeding until medical attention. All further criticals use Sudden Death; recovery takes 10 weeks and movement-related skills are lost until full recovery.", "Miednica zostaje roztrzaskana. Postać pada; wszystkie cechy są o połowę mniejsze, a krwotok wewnętrzny powoduje utratę K4 punktów Żywotności na rundę do czasu pomocy medycznej. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci; powrót do zdrowia trwa 10 tygodni, a umiejętności ruchowe są utracone do pełnego wyzdrowienia."),
		effect("The leg is torn off at the hip. The victim collapses and can do nothing until medical attention, losing D6 Wounds per round. All further criticals use Sudden Death.", "Noga zostaje oderwana w biodrze. Postać pada i nie może nic robić do czasu pomocy medycznej, tracąc K6 punktów Żywotności na rundę. Kolejne trafienia krytyczne rozstrzyga się Tabelą Nagłej Śmierci."),
		effect("The hip joint is almost totally destroyed and a major artery is severed. Death from shock and blood loss is almost instantaneous.", "Staw biodrowy zostaje niemal całkowicie zniszczony, a główna tętnica przerwana. Śmierć wskutek szoku i utraty krwi następuje niemal natychmiast.", DETAILED_CRITICAL_OUTCOME.KILLED),
		effect("The blow smashes through the leg into the pelvis and lower abdomen, causing catastrophic blood loss. The victim dies almost instantly.", "Cios przebija nogę, miednicę i podbrzusze, powodując katastrofalny krwotok. Postać umiera niemal natychmiast.", DETAILED_CRITICAL_OUTCOME.KILLED),
	],
});

/** Register cancellable guards which keep managed Core detailed tables read-only. */
export function registerCoreDetailedCriticalTableProtection() {
	Hooks.on("preUpdateRollTable", (table, _changes, options) =>
		protectCoreDocument(table, options));
	Hooks.on("preDeleteRollTable", (table, options) =>
		protectCoreDocument(table, options));

	for (const hook of [
		"preCreateTableResult",
		"preUpdateTableResult",
		"preDeleteTableResult",
	]) {
		Hooks.on(hook, (result, ...args) => {
			const options = hook === "preDeleteTableResult"
				? args[0]
				: args[1];
			return protectCoreDocument(result?.parent, options);
		});
	}
}

/** Ensure all system-managed Core detailed critical fallback RollTables exist. */
export async function ensureCoreDetailedCriticalTables() {
	if (!game.user?.isGM) return;

	const language = presentationLanguage();

	for (const variant of CRITICAL_VALUE_VARIANTS) {
		await ensureManagedTable({
			id: CHART_TABLE_IDS[variant],
			role: CRITICAL_TABLE_ROLE.DETAILED_CHART,
			variant,
			language,
			build: () => buildChartTableData(variant, language),
		});
	}

	for (const [location, definition] of Object.entries(EFFECT_TABLES)) {
		await ensureManagedTable({
			id: definition.id,
			role: definition.role,
			variant: CRITICAL_TABLE_VARIANT.DEFAULT,
			language,
			build: () => buildEffectTableData(location, definition, language),
		});
	}

	game.tables?.render?.(false);
}

export function detailedCriticalEffectText(location, effectNumber, language = presentationLanguage()) {
	const normalizedLocation = normalizeEffectLocation(location);
	const number = positiveEffectNumber(effectNumber);
	const definition = EFFECTS[normalizedLocation]?.[number - 1];
	if (!definition) return "";
	return definition[normalizeLanguage(language)];
}

export function detailedCriticalEffectOutcome(location, effectNumber) {
	const normalizedLocation = normalizeEffectLocation(location);
	const number = positiveEffectNumber(effectNumber);
	return EFFECTS[normalizedLocation]?.[number - 1]?.outcome ?? null;
}

export function detailedCriticalLocationLabel(location, language = presentationLanguage()) {
	return locationLabel(normalizeEffectLocation(location), normalizeLanguage(language));
}

export function isCoreDetailedEffectProvider(providerId) {
	const id = String(providerId ?? "").trim();
	return Object.values(EFFECT_TABLES).some((entry) => entry.providerId === id);
}

function buildChartTableData(variant, language) {
	const variantIndex = CRITICAL_VALUE_VARIANTS.indexOf(variant);
	if (variantIndex < 0) {
		throw new Error(`Unknown detailed critical variant '${variant}'.`);
	}

	const presentation = PRESENTATION[language];

	return {
		_id: CHART_TABLE_IDS[variant],
		name: presentation.chartName(variant),
		description: presentation.chartDescription,
		formula: "1d100",
		replacement: true,
		displayRoll: true,
		ownership: {
			default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
		},
		flags: tableFlags(
			CRITICAL_TABLE_ROLE.DETAILED_CHART,
			variant,
			language,
		),
		results: DETAILED_CHART_BANDS.map((entry) => {
			const outcome = entry.effects[variantIndex];
			const number = typeof outcome === "number" ? outcome : outcome.number;
			const flee = typeof outcome === "object" && outcome.flee === true;

			return {
				type: "text",
				text: `${presentation.effect} ${number}${flee ? ` ${presentation.flee}` : ""}`,
				range: [...entry.range],
				weight: 1,
				drawn: false,
				flags: {
					[FLAG_SCOPE]: {
						[CHART_RESULT_FLAG_KEY]: {
							effectNumber: number,
							flee,
						},
					},
				},
			};
		}),
	};
}

function buildEffectTableData(location, definition, language) {
	const presentation = PRESENTATION[language];

	return {
		_id: definition.id,
		name: presentation.effectName(location),
		description: presentation.effectDescription,
		formula: "1d16",
		replacement: true,
		displayRoll: false,
		ownership: {
			default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
		},
		flags: tableFlags(
			definition.role,
			CRITICAL_TABLE_VARIANT.DEFAULT,
			language,
		),
		results: EFFECTS[location].map((entry, index) => ({
			type: "text",
			text: entry[language],
			range: [index + 1, index + 1],
			weight: 1,
			drawn: false,
			flags: {
				[FLAG_SCOPE]: {
					[EFFECT_RESULT_FLAG_KEY]: {
						location,
						effectNumber: index + 1,
						outcome: entry.outcome,
					},
				},
			},
		})),
	};
}

async function ensureManagedTable({ id, role, variant, language, build }) {
	const existing = game.tables?.get(id) ?? null;

	if (existing) {
		const metadata = coreMetadata(existing);
		if (!metadata) {
			console.error(
				`WFRP1ED | Cannot materialize Core detailed critical table '${role}' '${variant}': RollTable id '${id}' is already used by a non-Core document.`,
			);
			return;
		}

		if (
			metadata.role === role &&
			metadata.variant === variant &&
			Number(metadata.version) === CORE_DETAILED_CRITICAL_TABLE_VERSION &&
			metadata.language === language
		) {
			return;
		}

		await existing.delete({
			[MAINTENANCE_OPTION]: true,
			render: false,
		});
	}

	await foundry.documents.RollTable.create(
		build(),
		{
			keepId: true,
			render: false,
			[MAINTENANCE_OPTION]: true,
		},
	);
}

function tableFlags(role, variant, language) {
	return {
		[FLAG_SCOPE]: {
			[TABLE_FLAG_KEY]: {
				role,
				variant,
				version: CORE_DETAILED_CRITICAL_TABLE_VERSION,
				language,
			},
		},
	};
}

function chartBand(min, max, effects) {
	return Object.freeze({
		range: Object.freeze([min, max]),
		effects: Object.freeze(effects),
	});
}

function star(number) {
	return Object.freeze({ number, flee: true });
}

function effect(en, pl, outcome = null) {
	return Object.freeze({ en, pl, outcome });
}

function presentationLanguage() {
	return normalizeLanguage(game.i18n.lang);
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl")
		? "pl"
		: "en";
}

function locationLabel(location, language) {
	const labels = {
		en: {
			arm: "Arm",
			head: "Head",
			body: "Body",
			leg: "Leg",
		},
		pl: {
			arm: "Ramię",
			head: "Głowa",
			body: "Korpus",
			leg: "Noga",
		},
	};
	return labels[normalizeLanguage(language)][location] ?? location;
}

function normalizeEffectLocation(location) {
	const normalized = String(location ?? "").trim();
	if (!Object.hasOwn(EFFECTS, normalized)) {
		throw new Error(`Unknown detailed critical effect location '${normalized}'.`);
	}
	return normalized;
}

function positiveEffectNumber(value) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 16) {
		throw new Error("Detailed critical effect number must be between 1 and 16.");
	}
	return number;
}

function coreMetadata(table) {
	if (!(table instanceof foundry.documents.RollTable)) return null;
	if (!MANAGED_TABLE_IDS.has(table.id)) return null;

	const value = table.getFlag?.(FLAG_SCOPE, TABLE_FLAG_KEY);
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: null;
}

function protectCoreDocument(table, options = {}) {
	if (options?.[MAINTENANCE_OPTION] === true) return;
	if (!coreMetadata(table)) return;

	ui.notifications.warn(
		PRESENTATION[presentationLanguage()].protectedWarning,
	);
	return false;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}

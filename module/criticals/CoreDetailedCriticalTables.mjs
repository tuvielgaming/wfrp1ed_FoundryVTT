import {
	CRITICAL_TABLE_ROLE,
	CRITICAL_TABLE_VARIANT,
	CRITICAL_VALUE_VARIANTS,
} from "./CriticalTableRegistry.mjs";

export const CORE_DETAILED_CHART_PROVIDER_ID =
	"wfrp1ed.core.detailed.chart";
export const CORE_DETAILED_CRITICAL_TABLE_VERSION = 2;

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
			"System-managed WFRP 1e Core fallback. Combat, printed pp. 122-124. Results preserve the Core mechanics and expand internal printed cross-references so every result is self-contained.",
		protectedWarning:
			"This is a system-managed WFRP 1e Core detailed-critical table. Duplicate it and configure the copy as an override for house rules.",
		effect: "Effect",
		flee: "— victim must flee combat if it is possible to do so",
	}),
	pl: Object.freeze({
		chartName: (variant) => `WFRP1ED Core — Tabela trafień krytycznych +${variant}`,
		effectName: (location) =>
			`WFRP1ED Core — Efekty trafień krytycznych — ${locationLabel(location, "pl")}`,
		chartDescription:
			"Zarządzana przez system domyślna tabela WFRP 1e Core. Walka, str. 122. Rzut K100 wskazuje numer efektu krytycznego dla odpowiedniego obszaru trafienia.",
		effectDescription:
			"Zarządzana przez system domyślna tabela WFRP 1e Core. Walka, str. 122-124. Wyniki zachowują mechanikę Księgi Głównej i mają statycznie rozwinięte wewnętrzne odwołania, aby każdy efekt był samodzielnym opisem.",
		protectedWarning:
			"To jest zarządzana przez system tabela szczegółowych trafień krytycznych WFRP 1e Core. Utwórz kopię i ustaw ją jako nadpisanie, aby użyć zasad własnych.",
		effect: "Efekt",
		flee: "— jeżeli jest to możliwe, ofiara musi uciekać z walki",
	}),
});

/*
 * Audited directly against the user-supplied WFRP 1e Core Rulebooks.
 *
 * English: Combat — Critical Hits / Critical Hit Chart / Critical Effects,
 * printed pp. 122-124 (PDF pages 123-125).
 * Polish: Walka — Trafienia krytyczne / Tabela trafień krytycznych /
 * Efekty trafień krytycznych, printed pp. 122-124 (PDF pages 127-129).
 *
 * IMPORTANT: the descriptions below preserve the audited Core mechanics, but
 * printed cross-references such as "see 3 above" are expanded statically so a
 * single RollTable result or Critical Wound description is self-contained.
 * English mechanics remain authoritative when the Polish translation differs.
 * For example, English Leg #6 calls for a test on half Initiative, while the
 * Polish text says a normal Initiative test; automation must follow English.
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
		effect(
			"Your opponent pulls the arm back to avoid serious injury, but drops anything held in that hand in the process.",
			"Twój przeciwnik, chcąc uniknąć poważnej rany, cofa gwałtownie ramię, wypuszczając wszystko, co trzymał w dłoni.",
		),
		effect(
			"Your blow skins your opponent's knuckles, painfully but not seriously. The arm may be used normally, but anything held in the hand is dropped.",
			"Twój cios zdziera skórę na kłykciach przeciwnika. Jest to bardzo bolesne, ale niezbyt groźne. Ramię działa normalnie, ale wszystkie trzymane w ręku przedmioty zostają upuszczone.",
		),
		effect(
			"Your blow strikes your opponent's hand, incapacitating the hand for the next round only and causing any object held in the hand to be dropped.",
			"Twój cios trafia w rękę przeciwnika, unieruchamiając ją na następną rundę (tylko) i powodując upuszczenie trzymanych w tej ręce przedmiotów.",
		),
		effect(
			"Your blow strikes your opponent's hand, dislocating the wrist. Anything held in that hand is dropped, and the hand is incapacitated until medical attention is received.",
			"Twój cios trafia w rękę przeciwnika, dyslokując kości w przegubie. Trafiony wypuszcza wszystko, co trzymał w tej ręce i nie będzie mógł nią władać do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your blow strikes your opponent's hand, shattering the fingers. Anything held in that hand is dropped, and the hand is incapacitated until medical attention is received.",
			"Twój cios trafia w rękę przeciwnika, gruchocząc palce. Trafiony wypuszcza wszystko, co trzymał w tej ręce i nie będzie mógł nią władać do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your blow strikes whatever your opponent is holding in that hand (generally a weapon or shield), shattering it completely. The object is destroyed, and the limb is numbed and incapacitated for D6 rounds.",
			"Twój cios trafia w to, co przeciwnik trzyma w ręku (przeważnie broń lub tarczę), całkowicie ten przedmiot niszcząc. Ramię wroga drętwieje i staje się bezwładne na K6 rund.",
		),
		effect(
			"Your blow misses your opponent's head by a fraction of an inch, striking the shoulder and dislocating it. The arm is incapacitated until medical attention is received.",
			"Twój cios mija o centymetry głowę przeciwnika i uderza w bark, powodując jego zwichnięcie. Ramię jest unieruchomione do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your blow opens a deep wound in the arm, cutting through muscle and sinew. Anything held in the hand is dropped, and the arm is incapacitated until medical attention is received.",
			"Twój cios przecina muskuły i ścięgna ramienia, zadając głęboką ranę. Trafiony wypuszcza wszystko, co trzymał w tej ręce i nie będzie mógł nią władać do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"There is a sickening crunch as your weapon smashes the bones of your opponent's forearm. Anything held in the hand is dropped, and the arm below the elbow is incapacitated until medical attention is received.",
			"Rozlega się przyprawiający o mdłości zgrzyt, gdy twoja broń przecina kości przedramienia przeciwnika. Wszystko, co było trzymane przez niego w dłoni zostaje upuszczone, a ręka poniżej łokcia do chwili otrzymania pomocy medycznej staje się niewładna.",
		),
		effect(
			"There is a sickening crunch as your weapon smashes your opponent's upper arm. Anything held in the hand is dropped, and the arm is incapacitated until medical attention is received.",
			"Rozlega się przyprawiający o mdłości zgrzyt, gdy twoja broń przecina kości ramienia wroga. Trafiony wypuszcza wszystko, co trzymał w tej ręce i nie będzie mógł nią władać do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"The target's arm is smashed, and an artery is severed. Anything held in the hand is dropped, and the arm is incapacitated until medical attention is received. Additionally, your opponent loses 1 Wound per round until medical attention is received. Resolve any further Critical Hits using the Sudden Death Critical Chart.",
			"Ręka przeciwnika jest zmiażdżona, a ostrze przecina kilka tętnic. Wszystkie trzymane w dłoni przedmioty zostają upuszczone. Ręka jest niewładna do chwili udzielenia pomocy medycznej. Dodatkowo co rundę do chwili jej otrzymania, twój przeciwnik traci 1 punkt Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your opponent stares with horror as blood pumps from the mangled stump of the wrist. Anything held in the hand is dropped (along with the hand itself), and your opponent falls unconscious to the ground, losing D4 Wounds per round until medical attention is received. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój przeciwnik z przerażeniem patrzy na krew tryskającą z uciętego kikuta ręki. Wszystkie trzymane w dłoni przedmioty zostają upuszczone (wraz z samą dłonią), a wróg pada nieprzytomny na ziemię. Do chwili otrzymania pomocy medycznej będzie tracił co rundę K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow tears off your opponent's arm at the elbow, splintering bone and mangling flesh. Your opponent collapses and may do nothing until medical attention is obtained. D4 Wounds are lost per round meanwhile. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios, tnąc ciało i rozłupując kości, przecina rękę przeciwnika na wysokości łokcia. Ranny traci przytomność i nie może nic robić do czasu otrzymania pomocy medycznej. W tym czasie traci co rundę K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow tears off your opponent's arm at the shoulder. Your opponent collapses and may do nothing until medical attention is obtained. D6 Wounds are lost per round meanwhile. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios przecina bark przeciwnika, odrąbując ramię. Przeciwnik mdleje i nie może nic robić do chwili otrzymania pomocy medycznej. W tym czasie traci co rundę K6 pkt Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow destroys your opponent's shoulder joint almost totally - the arm hangs limply, a mass of tattered and pulpy flesh with protruding fragments of bone. By chance, one of the bone splinters has severed a major artery, and after a fraction of a second your opponent collapses, with blood pouring out from the ruins of his shoulder. Death from shock and blood loss is almost instantaneous.",
			"Twój cios miażdży bark przeciwnika, zamieniając go w krwawą masę mięśni i potrzaskanych kości. Jeden z odłamków kostnych przecina jakąś ważną tętnicę i przeciwnik omdlewa, krwawiąc obficie. Śmierć na skutek szoku i upływu krwi jest prawie natychmiastowa.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your blow smashes through the arm and into the chest, caving in one side of the ribcage. The arm is completely destroyed, and blood showers yourself and your opponent. Your opponent collapses dying almost instantly from shock and blood loss.",
			"Twój cios przecina ramię i trafia w klatkę piersiową wroga, zagłębiając się w żebra. Ręka jest całkowicie odcięta, krew z rany tryska na ciebie i wszędzie wokół. Twój wróg omdlewa i prawie natychmiast umiera na skutek szoku oraz utraty krwi.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
	],
	head: [
		effect(
			"Your opponent ducks as your weapon whistles past the side of his head, saving his life, but losing the tip of one ear, which is torn off. Your opponent may make no attacks in the next round, but may parry; thereafter combat proceeds as normal.",
			"Twój przeciwnik uchyla się, gdy broń muska jego głowę, ratując życie, ale tracąc kawałek ucha. W następnej rundzie nie może robić nic poza parowaniem – później walka toczy się normalnie.",
		),
		effect(
			"A glancing blow stuns your opponent, who may do nothing except parry in the next round.",
			"Uderzenie ześlizguje się z głowy przeciwnika, oszałamiając go. W następnej rundzie może tylko parować twoje ciosy.",
		),
		effect(
			"Your blow stuns your opponent, who may do nothing except parry for the next D4 rounds.",
			"Twój cios oszałamia przeciwnika, który przez następne K4 rundy nie może robić nic, poza parowaniem.",
		),
		effect(
			"Your blow stuns your opponent, who is dazed and may do nothing at all for the next round.",
			"Twój cios oszałamia przeciwnika, który nie może nic robić przez następną rundę.",
		),
		effect(
			"Your blow stuns your opponent, who is dazed and may do nothing at all for the next D4 rounds.",
			"Twój cios oszałamia przeciwnika tak bardzo, że nie może on nic robić przez następne K4 rundy.",
		),
		effect(
			"Your opponent is knocked down and dazed, will count as prone for the next round, and may do nothing except parry for the next D4 rounds while climbing back upright.",
			"Twój przeciwnik pada ogłuszony na ziemię, w następnej rundzie uważa się go za cel statyczny. Później, wstając, nie może robić nic, poza parowaniem, przez K4 rundy.",
		),
		effect(
			"Your blow opens a flesh wound in your opponent's scalp - beneath any helmet. Scalp wounds are notorious for bleeding, and blood flows down into your opponent's eyes, giving a -10 modifier to 'to hit' rolls until medical attention is received.",
			"Twój cios zdziera przeciwnikowi płat skóry na głowie (bez względu na hełm). Rana bardzo krwawi, zalewając oczy wroga. Do czasu otrzymania pomocy medycznej ma on ujemny modyfikator -10% do Walki Wręcz.",
		),
		effect(
			"Your blow strikes your opponent's jaw, breaking the jawbone and causing the loss of several teeth. Dazed by the shock, your opponent may do nothing except parry for the next round; thereafter, the pain and the necessity to spit out blood and teeth cause your opponent to attack at -10 until medical attention is received.",
			"Twój cios trafia w szczękę przeciwnika, łamie żuchwę i wybija kilka zębów. Na skutek szoku w następnej rundzie nie może on robić nic, poza parowaniem, zaś w kolejnych rundach, do czasu otrzymania opieki medycznej, walczy z ujemnym modyfikatorem -10% do Walki Wręcz.",
		),
		effect(
			"Your blow destroys one of your opponent's eyes (determine which one randomly, if necessary). Your opponent may do nothing at all next round, and attacks at -10 until medical attention is received. Any sight-related skills are lost, including Night Vision bonuses, and BS is reduced by 20 points (subject to a minimum score of 5).",
			"Twój cios wybija przeciwnikowi oko (określ losowo które, jeśli to konieczne). W następnej rundzie nie może on robić w ogóle nic, a do czasu otrzymania pomocy medycznej atakuje z ujemnym modyfikatorem -10% do Walki Wręcz. Wszystkie umiejętności związane ze wzrokiem, wliczając w to widzenie w ciemności, są stracone, a US zmniejszają się o 20% (jednak do minimum, równego 5%).",
		),
		effect(
			"Your opponent is concussed, and may do nothing for D4 hours or until medical attention is obtained.",
			"Twój przeciwnik doznał szoku i nie może nic robić przez następne K4 godziny lub do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your opponent is severely concussed, and may do nothing for D10 hours or until medical attention is obtained. Additionally, your opponent must test against Toughness or lose 10 points from each percentage characteristic as a result of lasting brain damage.",
			"Twój przeciwnik jest w stanie potężnego szoku i nie może nic robić przez następne K10 godzin lub do czasu otrzymania pomocy medycznej. Dodatkowo musi wykonać udany test Wytrzymałości, albo, jako rezultat obrażeń mózgu, straci 10 punktów każdej cechy procentowej.",
		),
		effect(
			"Your blow ruptures your opponent's carotid artery, and both of you are drenched in a fountain of blood. Your opponent collapses, and will bleed to death in D4 rounds unless medical attention is received.",
			"Twój cios przecina tętnicę szyjną przeciwnika. Obu was zalewa fontanna krwi. Twój przeciwnik pada nieprzytomny na ziemię i wykrwawi się w ciągu K4 rund, jeśli wcześniej nie otrzyma pomocy medycznej.",
		),
		effect(
			"Your blow strikes the point of your opponent's jaw, forcing the jawbone upwards and into the lower part of the brain. Your opponent collapses and will die in D6 rounds unless medical attention is received. If the medical attention is successful, your opponent must test against Toughness or lose 10 points from each percentage characteristic as a result of lasting brain damage.",
			"Twój cios trafia od dołu w szczękę przeciwnika, wbijając żuchwę w głąb mózgu. Przeciwnik nieprzytomny pada na ziemię i jeśli nie otrzyma pomocy medycznej, umrze w ciągu K6 rund. Jeżeli opieka będzie skuteczna, ranny musi wykonać test Wytrzymałości albo wskutek obrażeń mózgu straci 10 punktów z każdej cechy procentowej.",
		),
		effect(
			"Your blow hits the neck, smashing the vertebrae. Your opponent falls to the ground, twitches for a couple of seconds, and then lays still.",
			"Twój cios trafia w kark, przecinając kręgi. Twój przeciwnik pada na ziemię, drga przez kilka sekund, a później nieruchomieje – na zawsze.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your blow shatters your opponent's skull. Death is instantaneous.",
			"Twój cios rozbija czaszkę przeciwnika. Śmierć jest natychmiastowa.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your opponent's head flies off in a random direction, landing 2D6 feet away.",
			"Po twoim ciosie głowa przeciwnika leci w losowo określonym kierunku i upada w odległości K3 metrów od ciała.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
	],
	body: [
		effect(
			"Your blow crashes into the chest. Winded, your opponent may do nothing except parry in the next round.",
			"Twój cios trafia w klatkę piersiową. Przeciwnik nie może zaczerpnąć oddechu i w ciągu następnej rundy nie może robić nic, poza parowaniem.",
		),
		effect(
			"Your blow strikes the groin. Doubled up in agony, your opponent may do nothing at all for the next round.",
			"Uderzasz przeciwnika w splot słoneczny. W następnej rundzie, wskutek przejmującego bólu, nie będzie mógł w ogóle nic robić.",
		),
		effect(
			"Your blow strikes the chest. Knocked to the ground, your opponent may only parry for the next D4 rounds until back upright.",
			"Twój cios trafia w klatkę piersiową. Przeciwnik pada na ziemię i przez następne K4 rundy, aż się podniesie, może tylko parować.",
		),
		effect(
			"Your blow lands with some force in the groin. Your opponent is knocked to the ground, dropping any hand-held object, and may do nothing except parry with a shield (if applicable) for the next D4 rounds until upright again.",
			"Twój cios silnie uderza przeciwnika w żebra. Przeciwnik pada na ziemię, upuszczając trzymane w rękach przedmioty i nie może nic robić, prócz parowania tarczą (jeśli ją posiada) przez następne K4 rundy, w czasie których próbuje wstać.",
		),
		effect(
			"Your blow lifts your opponent into the air and then to the ground. Your opponent is stunned for D4 rounds, counting as a prone target, and may only parry for another D4 rounds until back upright.",
			"Twój cios wyrzuca przeciwnika w powietrze. Przez K4 rundy jest ogłuszony, leży na ziemi i traktuje się go jako cel nieruchomy, a przez następne K4 rundy, do chwili powstania, może tylko parować twoje ciosy.",
		),
		effect(
			"Your blow smashes several ribs. Your opponent may do nothing for the next round, and attacks at -10 until medical attention is received.",
			"Twój cios łamie przeciwnikowi kilka żeber. W następnej rundzie nie może on nic robić, a do czasu otrzymania pomocy medycznej jego WW jest modyfikowana o -10%.",
		),
		effect(
			"Your blow smashes your opponent's collar-bone. The pain reduces all characteristics by 1 or 10 points as appropriate until medical attention is received.",
			"Twój cios trafia w obojczyk przeciwnika. Do czasu otrzymania pomocy medycznej, ból redukuje wszystkie cechy wroga o 1 lub 10 punktów (odpowiednio dziesiętne lub procentowe).",
		),
		effect(
			"Your blow fractures your opponent's hip. The pain reduces all characteristics by 1 or 10 points as appropriate, and movement allowance is halved until medical attention is received. Your opponent must test Initiative each round or fall over (counts as a prone target, may only parry for the next D4 rounds until upright). Skills such as Acrobatics, Dance, Flee, Trick Riding, and Scale Sheer Surface are lost until medical attention is received.",
			"Twój cios miażdży staw biodrowy przeciwnika. Do czasu otrzymania pomocy medycznej, ból redukuje wszystkie jego cechy odpowiednio o 1 lub 10 punktów oraz do połowy ogranicza Szybkość. Przeciwnik musi wykonać w każdej rundzie udany test Inicjatywy, albo upadnie (na K4 rundy stanie się celem statycznym i w tym czasie może tylko parować ciosy). Do czasu uzyskania opieki medycznej traci takie umiejętności, jak akrobatyka, taniec, ucieczka, woltyżerka, wspinaczka.",
		),
		effect(
			"Your blow strikes the abdomen, and your opponent collapses unconscious, losing 1 Wound per round through internal bleeding until medical attention is received.",
			"Trafiłeś przeciwnika w podbrzusze. Pada nieprzytomny na ziemię i wskutek krwawienia wewnętrznego traci 1 punkt Żywotności na rundę do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your opponent's ribs are shattered, and a shard of bone is driven into one lung, causing it to collapse. Your opponent falls unconscious, losing D4 Wounds per round through internal bleeding until medical attention is received. Even then, your opponent will be totally incapacitated for at least 10 weeks, and loses 1 point of Toughness permanently.",
			"Twój cios łamie żebra przeciwnika, odłamki przebijają płuco i ranny, tracąc przytomność, pada na ziemię. Do czasu otrzymania pomocy medycznej traci, wskutek krwawienia wewnętrznego, K4 punkty Żywotności na rundę. Nawet po otrzymaniu pomocy, będzie całkowicie wyłączony z akcji przez przynajmniej 10 tygodni i na stałe straci 1 punkt Wytrzymałości.",
		),
		effect(
			"Your blow smashes into your opponent's abdomen, causing internal injuries. Your opponent falls to the ground in extreme pain, only able to parry, and must test Toughness each round or pass out. Medical attention will allow movement at half the cautious rate, and all characteristics are halved for 3D6 weeks. Any skills involving movement of any kind are lost until a full recovery is made.",
			"Twój cios trafił w podbrzusze, uszkadzając narządy wewnętrzne wroga. Przeciwnik w straszliwym bólu pada na ziemię, zdolny jedynie do parowania ciosów. Co rundę musi wykonać udany test Wytrzymałości albo zemdleje. Opieka medyczna umożliwi mu poruszanie się z połową szybkości ostrożnej, a wszystkie cechy są zmniejszone o połowę na okres 3K6 tygodni. Do chwili pełnej rekonwalescencji wszystkie umiejętności związane z ruchem są stracone.",
		),
		effect(
			"Your blow crunches into the spine. Knocked to the ground, your opponent may do nothing until medical attention is received, and must test against Toughness or be permanently paralysed from the waist down.",
			"Twój cios trafia w kręgosłup wroga. Przeciwnik pada na ziemię i do czasu otrzymania pomocy medycznej nie może nic robić. Musi także wykonać udany test Wytrzymałości, albo zostanie na stałe sparaliżowany od pasa w dół.",
		),
		effect(
			"Your blow shatters the pelvis. Your opponent falls to the ground, and may only parry. The pain halves all characteristics, and D4 Wounds are lost per round through internal bleeding until medical attention is received. Recovery takes 10 weeks, and skills involving movement of any kind are lost until a full recovery is made.",
			"Twój cios trafia w miednicę przeciwnika. Pada on na ziemię i może tylko parować ciosy. Ból zmniejsza o połowę wszystkie jego cechy, dodatkowo co rundę, aż do czasu otrzymania pomocy medycznej, traci na skutek wewnętrznego krwawienia K4 punkty Żywotności. Rekonwalescencja potrwa 10 tygodni, a do czasu pełnego wyzdrowienia wszystkie umiejętności związane z ruchem są stracone.",
		),
		effect(
			"Your blow caves in your opponent's chest, rupturing several internal organs and causing death in a matter of seconds.",
			"Cios zagłębia się w klatkę piersiową przeciwnika, uszkadzając kilka organów wewnętrznych i powodując śmierć w ciągu kilku sekund.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your opponent's abdominal cavity ruptures, spilling entrails over a wide area. Death is instantaneous.",
			"Twój cios rozcina podbrzusze wroga, jego wnętrzności wypływają na zewnątrz. Śmierć jest natychmiastowa.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your blow smashes your opponent's spine and abdomen, tearing muscle and shattering bone so that your opponent falls to the ground in two separate places.",
			"Twój cios trafia przeciwnika w połowie wysokości ciała, przecinając mięśnie i miażdżąc kości. Wróg pada na ziemię, niemal rozcięty na pół.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
	],
	leg: [
		effect(
			"A glancing blow to the calf makes your opponent stumble, dropping any hand-held object unless a successful Dexterity test is made.",
			"Twój cios ześlizguje się i trafia w łydkę przeciwnika, który potyka się i, jeśli nie wykona udanego testu Zręczności, wypuszcza wszystkie trzymane w rękach przedmioty.",
		),
		effect(
			"Your blow trips your opponent, who may only parry for the next round.",
			"Twój cios wytrąca przeciwnika z równowagi i w następnej rundzie może on tylko parować ciosy.",
		),
		effect(
			"Your blow knocks your opponent to the ground, jarring any hand-held object loose unless a Dexterity test is passed. Your opponent may only parry for the next D4 rounds until back upright, and then only if still in possession of a weapon or shield.",
			"Twe uderzenie powala przeciwnika na ziemię. Jeżeli nie wykona on udanego testu na Zręczność, wstrząs wytrąci mu z rąk wszystkie przedmioty. Przez K4 rundy usiłuje się podnieść i może jedynie parować, ale tylko, jeśli nadal trzyma broń lub tarczę.",
		),
		effect(
			"Your blow numbs your opponent's leg. Movement allowance and Initiative are halved for D4 rounds.",
			"Od twojego ciosu noga przeciwnika drętwieje, niemal nie może na niej stać. Jego Szybkość i Inicjatywa spada o połowę na następne K4 rundy.",
		),
		effect(
			"Your blow strikes the target's ankle, dislocating it. Movement allowance and Initiative are halved until medical attention is received. Your opponent must pass an Initiative test or be knocked down. If knocked down, any hand-held object is jarred loose unless a Dexterity test is passed; for the next D4 rounds until back upright the opponent may only parry, and only if still in possession of a weapon or shield.",
			"Twój cios trafia wroga w kostkę, przemieszczając ją. Do czasu otrzymania pomocy medycznej jego Szybkość i Inicjatywa są zmniejszone o połowę. Ponadto musi wykonać udany test Inicjatywy, albo upadnie na ziemię. Jeżeli zostanie powalony, wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności; przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę.",
		),
		effect(
			"Your blow strikes your opponent's hip, dislocating the leg. Movement allowance and Initiative are halved until medical attention is received. Your opponent must pass a test on half Initiative or be knocked down. If knocked down, any hand-held object is jarred loose unless a Dexterity test is passed; for the next D4 rounds until back upright the opponent may only parry, and only if still in possession of a weapon or shield.",
			"Twój cios trafia w biodro przeciwnika, przetrącając mu nogę. Do czasu otrzymania pomocy medycznej jego Szybkość i Inicjatywa są zmniejszone o połowę. Dodatkowo musi wykonać udany test Inicjatywy, albo upadnie na ziemię. Jeżeli zostanie powalony, wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności; przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę.",
		),
		effect(
			"Your blow strikes the target's shin, shattering the bones. Your opponent is knocked down, jarring any hand-held object loose unless a Dexterity test is passed. For the next D4 rounds until back upright the opponent may only parry, and only if still in possession of a weapon or shield. Movement allowance and Initiative are halved until medical attention is received.",
			"Cios trafia w goleń wroga, miażdżąc kość. Twój przeciwnik pada na ziemię i wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności. Przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę. Jego Szybkość i Inicjatywa są zmniejszone o połowę do czasu otrzymania pomocy medycznej.",
		),
		effect(
			"Your blow opens a deep wound in the leg, cutting through muscle and sinew. Your opponent is knocked down, jarring any hand-held object loose unless a Dexterity test is passed. For the next D4 rounds until back upright the opponent may only parry, and only if still in possession of a weapon or shield. The target loses 1 Wound per round from heavy bleeding. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios zadaje głęboką ranę, tnąc mięśnie i ścięgna w nodze wroga. Przeciwnik pada na ziemię i wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności. Przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę. Wskutek krwawienia traci co rundę 1 punkt Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"The target's thigh is smashed, and an artery is severed. Your opponent falls to the ground, jarring any hand-held object loose unless a Dexterity test is passed. While down, the opponent may only parry, and only if still in possession of a weapon or shield; rising requires a successful Initiative test. Additionally, the target loses 1 Wound per round until medical attention is received. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios miażdży udo wroga i przecina tętnicę. Przeciwnik pada na ziemię i wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności. Leżąc może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę; może wstać dopiero po udanym teście Inicjatywy. Dodatkowo, do czasu otrzymania pomocy medycznej traci w każdej rundzie 1 punkt Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"There is a sickening crunch as your weapon smashes the bones of the target's hip and thigh. Your opponent is swept to the floor and drops anything hand-held. For the next D4 rounds until back upright the opponent may only parry, and only if in possession of a weapon or shield. The target loses D4 Wounds per round until medical attention is received. Resolve all further Critical Hits using the Sudden Death Critical Chart. Your opponent may only stand and walk if supported by at least one other character.",
			"Rozlega się przyprawiający o mdłości zgrzyt, kiedy twoja broń przecina kości uda i biodra przeciwnika. Wróg zostaje powalony na ziemię i upuszcza wszystkie trzymane w rękach przedmioty. Przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli ma broń lub tarczę. W każdej rundzie, do czasu otrzymania pomocy medycznej, traci również K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci. Twój przeciwnik może stać i chodzić tylko wtedy, gdy pomaga mu przynajmniej jedna osoba.",
		),
		effect(
			"Your opponent stares with horror as blood pumps from the mangled stump of the ankle, then falls unconscious to the ground, losing D4 Wounds per round until medical attention is received. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój przeciwnik patrzy osłupiały na krew, tryskającą z kikuta obciętej stopy, a potem pada nieprzytomny na ziemię. Do czasu otrzymania pomocy medycznej traci co rundę K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow tears off your opponent's leg at the knee, splintering bone and mangling flesh. Your opponent collapses and may do nothing until medical attention is obtained. D4 Wounds are lost per round meanwhile. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios trafia w kolano wroga i przecina mu nogę, miażdżąc ciało oraz łamiąc kości. Twój przeciwnik traci przytomność i pada na ziemię. Nie jest zdolny do robienia czegokolwiek, aż do otrzymania pomocy medycznej. Tymczasem co rundę traci K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow shatters the pelvis. Your opponent falls to the ground, jarring any hand-held object loose unless a Dexterity test is passed. For the next D4 rounds until back upright the opponent may only parry, and only if still in possession of a weapon or shield. The pain halves all characteristics, and D4 Wounds are lost per round through internal bleeding until medical attention is received. Resolve all further Critical Hits using the Sudden Death Critical Chart. Recovery takes 10 weeks, and skills involving movement of any kind are lost until a full recovery is made.",
			"Twój cios gruchocze miednicę przeciwnika, który pada na ziemię i wypuszcza wszystkie trzymane w rękach przedmioty, chyba że wykona udany test Zręczności. Przez następne K4 rundy, podczas podnoszenia się, może jedynie parować, i tylko jeśli nadal trzyma broń lub tarczę. Ból zmniejsza o połowę wszystkie jego cechy. Dodatkowo, podczas każdej rundy do czasu otrzymania pomocy medycznej, traci w wyniku krwotoku wewnętrznego K4 punkty Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci. Rekonwalescencja potrwa 10 tygodni; do czasu pełnego wyzdrowienia stracone są wszystkie umiejętności związane z ruchem jakiegokolwiek rodzaju.",
		),
		effect(
			"Your blow tears off your opponent's leg at the hip. Your opponent collapses and may do nothing until medical attention is obtained. D6 Wounds are lost per round meanwhile. Resolve all further Critical Hits using the Sudden Death Critical Chart.",
			"Twój cios odcina nogę przeciwnika na wysokości biodra. Wróg pada nieprzytomny na ziemię i nie może nic robić do czasu otrzymania pomocy medycznej. W tym czasie traci co rundę K6 punktów Żywotności. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.",
		),
		effect(
			"Your blow destroys your opponent's hip joint almost totally - the leg hangs limply, a mass of tattered and pulpy flesh with protruding fragments of bone. By chance, one of the bone splinters has severed a major artery, and after a fraction of a second your opponent collapses, with blood pouring out from the ruined hip. Death from shock and blood loss is almost instantaneous.",
			"Twój cios niemal całkowicie miażdży staw biodrowy przeciwnika, zmieniając go w krwawą masę mięśni i potrzaskanych kości. Jeden z odłamków przecina którąś z ważnych tętnic i przeciwnik pada nieprzytomny na ziemię, wprost w kałużę krwi tryskającej ze zmiażdżonego stawu. Śmierć na skutek szoku i utraty krwi jest prawie natychmiastowa.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
		effect(
			"Your blow smashes through the leg and into the pelvis, caving in the lower abdomen. Blood showers yourself and your opponent. Your opponent collapses dying almost instantly from shock and blood loss.",
			"Twój cios przecina udo i miednicę, zagłębiając się w podbrzusze przeciwnika. Krew tryska na ciebie i wszędzie wokół. Wróg pada na ziemię, niemal w tej samej chwili umierając.",
			DETAILED_CRITICAL_OUTCOME.KILLED,
		),
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
		throw new Error(`Unknown Core detailed critical variant '${variant}'.`);
	}

	const presentation = PRESENTATION[language];
	return {
		_id: CHART_TABLE_IDS[variant],
		name: presentation.chartName(variant),
		description: presentation.chartDescription,
		formula: "1d100",
		replacement: true,
		displayRoll: false,
		ownership: {
			default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
		},
		flags: tableFlags(
			CRITICAL_TABLE_ROLE.DETAILED_CHART,
			variant,
			language,
		),
		results: DETAILED_CHART_BANDS.map((band) => {
			const selected = band.effects[variantIndex];
			const number = typeof selected === "object"
				? selected.number
				: selected;
			const flee = typeof selected === "object" && selected.flee === true;
			return {
				type: "text",
				text: `${presentation.effect} ${number}${flee ? ` ${presentation.flee}` : ""}`,
				range: [...band.range],
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

/**
 * Keep managed table/result IDs stable. Critical Wound provenance stores the
 * resolved TableResult id, so correcting localization text must never recreate
 * those embedded documents merely to update wording.
 */
async function ensureManagedTable({ id, role, variant, language, build }) {
	const existing = game.tables?.get(id) ?? null;
	const desired = build();

	if (existing) {
		const metadata = coreMetadata(existing);
		if (!metadata) {
			console.error(
				`WFRP1ED | Cannot materialize Core detailed critical table '${role}' '${variant}': RollTable id '${id}' is already used by a non-Core document.`,
			);
			return;
		}

		await synchronizeManagedTable(existing, desired);
		return;
	}

	await foundry.documents.RollTable.create(
		desired,
		{
			keepId: true,
			render: false,
			[MAINTENANCE_OPTION]: true,
		},
	);
}

async function synchronizeManagedTable(table, desired) {
	const tableChanges = {
		name: desired.name,
		description: desired.description,
		formula: desired.formula,
		replacement: desired.replacement,
		displayRoll: desired.displayRoll,
		ownership: desired.ownership,
		[`flags.${FLAG_SCOPE}.${TABLE_FLAG_KEY}`]:
			foundry.utils.deepClone(desired.flags?.[FLAG_SCOPE]?.[TABLE_FLAG_KEY] ?? {}),
	};
	await table.update(tableChanges, {
		render: false,
		[MAINTENANCE_OPTION]: true,
	});

	const current = [...(table.results ?? [])]
		.sort((left, right) => Number(left.range?.[0] ?? 0) - Number(right.range?.[0] ?? 0));
	const wanted = [...(desired.results ?? [])]
		.sort((left, right) => Number(left.range?.[0] ?? 0) - Number(right.range?.[0] ?? 0));

	if (current.length !== wanted.length) {
		throw new Error(
			`Managed Core detailed table '${table.name}' has ${current.length} results; expected ${wanted.length}. Refusing to replace result ids used by Critical Wound provenance.`,
		);
	}

	const updates = current.map((result, index) => ({
		_id: result.id,
		type: wanted[index].type,
		text: wanted[index].text,
		range: foundry.utils.deepClone(wanted[index].range),
		weight: wanted[index].weight,
		drawn: false,
		flags: foundry.utils.deepClone(wanted[index].flags ?? {}),
	}));

	if (updates.length) {
		await table.updateEmbeddedDocuments(
			"TableResult",
			updates,
			{
				render: false,
				[MAINTENANCE_OPTION]: true,
			},
		);
	}
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

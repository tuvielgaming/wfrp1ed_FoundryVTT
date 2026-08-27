/**
 * Audited WFRP 1e Core personal-equipment catalogue.
 *
 * Source authority:
 * - English Core, Combat pp. 118-129 and Consumer Guide pp. 292-297.
 * - Polish Core, Walka pp. 118-129 and Poradnik Konsumenta pp. 292-297.
 *
 * Scope is deliberately Item-shaped physical property: subsistence goods,
 * clothing, carrying and household gear, illumination, instruments, tools,
 * books, armour, weapons and ammunition. Services, travel fares, dwellings,
 * vehicles and creatures belong to other document/procedure layers and are
 * not disguised as carryable Equipment Items here.
 *
 * `catalogId` is stable content identity. `system.rulesId` remains blank unless
 * executable code actually consumes it; table-authored facts instead use the
 * native Weapon/Armour/Equipment fields. Manual special procedures are stated
 * in descriptions rather than receiving invented Rules IDs.
 */

const CORE_CATALOG_VERSION = 1;
const IMAGE_ROOT = "systems/wfrp1ed/assets/core-equipment";

const AVAILABILITY = Object.freeze({
	veryRare: ["Very Rare", "Znikoma"],
	rare: ["Rare", "Niewielka"],
	scarce: ["Scarce", "Mała"],
	average: ["Average", "Przeciętna"],
	common: ["Common", "Duża"],
	plentiful: ["Plentiful", "Powszechna"],
});

const P = (gc = 0, ss = 0, bp = 0, formulaEn = "", formulaPl = "") =>
	Object.freeze({ gc, ss, bp, formulaEn, formulaPl });
const C = (...areas) => Object.freeze(areas);
const M = (initiative = 0, toHit = 0, damage = 0, parry = 0) =>
	Object.freeze({ initiative, toHit, damage, parry });

const ARMOUR = Object.freeze([
	armour("leather-coif", "Leather Coif", "Czepiec skórzany", P(6), 10, "common", "leather", "leatherCoif", 1, C("head"), { note: leatherNote() }),
	armour("leather-jacket", "Leather Jacket", "Kurtka skórzana", P(17), 50, "common", "leather", "leatherJacket", 1, C("body", "rightArm", "leftArm"), { note: leatherNote() }),
	armour("leather-jerkin", "Leather Jerkin", "Kaftan skórzany", P(12), 40, "common", "leather", "leatherJerkin", 1, C("body"), { note: leatherNote() }),
	armour("mail-shirt", "Mail Shirt", "Koszulka kolcza", P(80), 60, "average", "mail", "mailShirt", 1, C("body")),
	armour("mail-coat", "Mail Coat", "Kaftan kolczy", P(115), 80, "average", "mail", "mailCoat", 1, C("body", "rightLeg", "leftLeg")),
	armour("sleeved-mail-shirt", "Sleeved Mail Shirt", "Koszulka kolcza z rękawami", P(95), 80, "average", "mail", "sleevedMailShirt", 1, C("body", "rightArm", "leftArm")),
	armour("sleeved-mail-coat", "Sleeved Mail Coat", "Kaftan kolczy z rękawami", P(130), 100, "average", "mail", "sleevedMailCoat", 1, C("body", "rightArm", "leftArm", "rightLeg", "leftLeg")),
	armour("mail-coif", "Mail Coif", "Czepiec kolczy", P(25), 30, "average", "mail", "mailCoif", 1, C("head")),
	armour("mail-leggings", "Mail Leggings (pair)", "Nagolenniki kolcze (para)", P(55), 60, "scarce", "mail", "leggings", 1, C("rightLeg", "leftLeg")),
	armour("mail-sleeves", "Mail Sleeves (pair)", "Naramienniki kolcze (para)", P(20), 40, "rare", "mail", "mailArmBracer", 1, C("rightArm", "leftArm")),
	armour("breastplate", "Breastplate", "Napierśnik", P(70), 75, "scarce", "plate", "breastplate", 1, C("body")),
	armour("back-plate", "Back Plate", "Naplecznik", P(50), 75, "scarce", "plate", "backPlate", 1, C("body")),
	armour("plate-leggings", "Cuisse & Greaves (pair)", "Nagolenniki płytowe (para)", P(70), 60, "scarce", "plate", "leggings", 1, C("rightLeg", "leftLeg")),
	armour("vambraces", "Vambraces (pair)", "Naramienniki płytowe (para)", P(60), 30, "scarce", "plate", "plateArmBracer", 1, C("rightArm", "leftArm")),
	armour("gauntlets", "Gauntlets (pair)", "Rękawice (para)", P(30), 10, "scarce", "plate", "gauntlets", 1, C("rightArm", "leftArm")),
	armour("knights-helm", "Knight's Helm", "Hełm rycerski", P(0, 0, 0, "20 + 1D10 GC", "20 + 1K10 ZK"), 40, "scarce", "plate", "helmet", 1, C("head")),
	armour("pot-helmet", "Pot Helmet", "Hełm otwarty", P(2), 30, "common", "plate", "potHelmet", 1, C("head"), { note: ["Gives no additional Armour Point when worn over a mail coif.", "Nie daje dodatkowego Punktu Pancerza, gdy jest noszony na czepcu kolczym."] }),
	armour("shield", "Shield", "Tarcza", P(0, 0, 0, "2D8 + 2 GC", "2K8 + 2 ZK"), 50, "common", "shield", "shield", 1, C("head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"), { parry: true, parryBonus: 20 }),
	armour("unrimmed-shield", "Unrimmed Shield", "Tarcza bez okuć", P(0, 10), 50, "plentiful", "shield", "shield", 1, C("head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"), { parry: true, parryBonus: 20, note: ["Temporary shield; lasts one adventure.", "Tymczasowa tarcza; wystarcza na jedną przygodę."] }),
]);

const MELEE = Object.freeze([
	melee("buckler", "Buckler", "Puklerz", P(2), 10, "average", "buckler", { group: "specialist", specialist: "specialistWeapon.parrying", modifiers: M(0, 0, -2, 20), parry: true }),
	melee("cutlass", "Cutlass", "Pałasz", P(14), 50, "scarce", "hand-weapon", { parry: true }),
	melee("dagger-knife", "Dagger / Knife", "Sztylet / nóż", P(3), 10, "common", "knife-dagger", { modifiers: M(10, 0, -2, -20), parry: true }),
	melee("flail", "Flail", "Kiścień", P(10), 60, "scarce", "flail", { group: "specialist", specialist: "specialistWeapon.flail", modifiers: M(0, -10, 1, -10), parry: true }),
	melee("foil", "Foil", "Floret", P(18), 40, "scarce", "rapier", { group: "specialist", specialist: "specialistWeapon.fencing", modifiers: M(20, 0, -1, 0), parry: true }),
	melee("garrotte", "Garrotte", "Garota", P(1), 1, "rare", "garrotte", { group: "specialist", specialist: "specialistWeapon.garrotte", handedness: "two", note: ["Uses the Core strangling procedure; automatic damage after a successful attack until the victim escapes with a Strength test. Resolve manually.", "Używa procedury duszenia z zasad podstawowych; po udanym ataku zadaje automatyczne obrażenia, dopóki ofiara nie uwolni się testem Siły. Rozstrzygaj ręcznie."] }),
	melee("halberd", "Halberd", "Halabarda", P(8), 175, "common", "halberd", { group: "specialist", specialist: "specialistWeapon.halberd", handedness: "two", modifiers: M(10, -10, 2, 0), parry: true, note: conditionalModifierNote("Halberd initiative and To Hit values have Core opponent/round conditions.", "Modyfikatory Inicjatywy i Trafienia halabardy zależą od przeciwnika i rundy zgodnie z zasadami podstawowymi.") }),
	melee("bastard-sword", "Hand-and-a-half Sword", "Miecz półtoraręczny", P(20), 100, "common", "bastard-sword", { group: "specialist", specialist: "specialistWeapon.bastardSword", handedness: "either", modifiers: M(-10, 0, 1, 0), parry: true }),
	melee("hand-axe", "Hand Axe", "Topór bojowy", P(6), 50, "common", "hand-weapon", { parry: true }),
	melee("horsemans-axe", "Horseman's Axe", "Topór jeździecki", P(7), 75, "scarce", "hand-weapon", { parry: true }),
	melee("hook", "Hook", "Hak", P(1), 1, "average", "fist-weapon", { modifiers: M(0, -10, -1, 0) }),
	melee("knuckle-duster", "Knuckle Duster", "Kastet", P(1), 1, "common", "fist-weapon", { modifiers: M(0, -10, -1, 0) }),
	melee("lance", "Lance", "Kopia", P(0, 10), 100, "rare", "lance", { group: "specialist", specialist: "specialistWeapon.lance", modifiers: M(20, 10, 2, -20), parry: true, note: ["The listed modifiers apply only while mounted and charging; otherwise treat as a hand weapon.", "Podane modyfikatory działają tylko podczas konnej szarży; w innych sytuacjach traktuj jako zwykłą broń ręczną."] }),
	melee("mace", "Mace", "Maczuga", P(7), 50, "common", "hand-weapon", { parry: true }),
	melee("military-pick", "Military Pick", "Nadzik", P(9), 60, "rare", "hand-weapon", { parry: true }),
	melee("morning-star", "Morning Star", "Morgenstern", P(14), 125, "rare", "flail", { group: "specialist", specialist: "specialistWeapon.flail", modifiers: M(0, -10, 1, -10), parry: true }),
	melee("net", "Net", "Sieć", P(0, 30), 30, "rare", "net", { group: "specialist", specialist: "specialistWeapon.net", handedness: "either", modifiers: M(0, -10, 0, -10), note: ["Entanglement, shield use and escape tests use the Core net procedure and are resolved manually.", "Splątanie, użycie jak tarczy i testy uwolnienia korzystają z procedury sieci z zasad podstawowych i są rozstrzygane ręcznie."] }),
	melee("quarter-staff", "Quarter Staff", "Kij", P(0, 3), 50, "plentiful", "quarter-staff", { group: "specialist", specialist: "specialistWeapon.quarterStaff", handedness: "two", modifiers: M(-10, 0, -1, 0), parry: true }),
	melee("rapier", "Rapier", "Rapier", P(20), 40, "scarce", "rapier", { group: "specialist", specialist: "specialistWeapon.fencing", modifiers: M(20, 0, -1, 0), parry: true }),
	melee("scabbard", "Scabbard", "Pochwa na miecz", P(1, 10), 20, "common", "improvised", { group: "improvised", modifiers: M(0, -10, -2, 10) }),
	melee("spear", "Spear", "Włócznia", P(0, 35), 50, "common", "spear", { handedness: "either", parry: true, note: conditionalModifierNote("The Core spear Initiative and To Hit bonuses are contextual and are not applied automatically by the fixed optional-modifier fields.", "Premie włóczni do Inicjatywy i Trafienia są sytuacyjne i nie są automatycznie stosowane przez stałe pola modyfikatorów opcjonalnych.") }),
	melee("sword", "Sword", "Miecz", P(14), 60, "common", "hand-weapon", { parry: true }),
	melee("sword-breaker", "Sword-Breaker", "Łamacz mieczy", P(5), 40, "scarce", "sword-breaker", { group: "specialist", specialist: "specialistWeapon.parrying", modifiers: M(0, 0, -2, -10), parry: true, note: ["The opposed Strength test used to break a parried sword or dagger is resolved manually.", "Przeciwstawny test Siły służący do złamania sparowanego miecza lub sztyletu jest rozstrzygany ręcznie."] }),
	melee("two-handed-axe", "Two-handed Axe", "Topór dwuręczny", P(12), 75, "average", "two-handed-weapon", twoHandedWeapon()),
	melee("two-handed-flail", "Two-handed Flail", "Korbacz dwuręczny", P(20), 120, "rare", "two-handed-flail", { group: "specialist", specialist: "specialistWeapon.twoHandedFlail", handedness: "two", modifiers: M(-20, -20, 3, -10), parry: true }),
	melee("two-handed-mace", "Two-handed Mace", "Maczuga dwuręczna", P(15), 100, "scarce", "two-handed-weapon", twoHandedWeapon()),
	melee("two-handed-sword", "Two-handed Sword", "Miecz dwuręczny", P(35), 250, "average", "two-handed-weapon", twoHandedWeapon()),
	melee("two-handed-warhammer", "Two-handed Warhammer", "Młot bojowy dwuręczny", P(15), 200, "rare", "two-handed-weapon", twoHandedWeapon()),
	melee("warhammer", "Warhammer", "Młot bojowy", P(8), 75, "scarce", "hand-weapon", { parry: true }),
	melee("whip", "Whip", "Bicz", P(0, 15), 30, "average", "whip", { group: "specialist", specialist: "specialistWeapon.whip", modifiers: M(0, -10, -2, -20), parry: true }),
	melee("wooden-club", "Wooden Club", "Pałka drewniana", P(0, 2), 40, "plentiful", "hand-weapon", { parry: true }),
]);

const RANGED = Object.freeze([
	ranged("blowpipe", "Blowpipe", "Dmuchawka", P(10), 15, "veryRare", "blowpipe", 12, 24, 50, 1, { group: "specialist", specialist: "specialistWeapon.blowpipe" }),
	ranged("bolas", "Bolas", "Bolas", P(0, 7), 20, "scarce", "bolas", 12, 24, 50, 1, { group: "specialist", specialist: "specialistWeapon.bolas", note: ["Entanglement, escape tests and its special critical rule are resolved manually.", "Splątanie, testy uwolnienia i specjalna zasada trafień krytycznych są rozstrzygane ręcznie."] }),
	ranged("crossbow", "Crossbow", "Kusza", P(16), 120, "average", "crossbow", 32, 64, 300, 4, { ammunition: "bolt", reload: 1, handedness: "two" }),
	ranged("crossbow-pistol", "Crossbow Pistol", "Pistolet strzałkowy", P(10), 25, "rare", "crossbow-pistol", 16, 32, 50, 1, { group: "specialist", specialist: "specialistWeapon.crossbowPistol", ammunition: "bolt", reload: 1 }),
	ranged("dart", "Dart", "Strzałka do rzucania", P(0, 2), 10, "scarce", "dart", 4, 8, 20, "character", { group: "specialist", specialist: "specialistWeapon.throwing" }),
	ranged("elf-bow", "Elf Bow", "Łuk elfi", P(30), 100, "veryRare", "elf-bow", 32, 64, 300, 4, { group: "specialist", ammunition: "arrow", handedness: "two", note: ["Requires no Specialist Weapon skill, but the Core limits effective use to Wood Elves; other races treat it as a short bow.", "Nie wymaga umiejętności Specjalna broń, ale według zasad podstawowych tylko Leśne Elfy używają go w pełni; dla innych ras działa jak łuk krótki."] }),
	ranged("javelin", "Javelin", "Oszczep", P(0, 25), 30, "average", "javelin", 8, 16, 50, "character"),
	ranged("lasso", "Lasso", "Lasso", P(1), 10, "plentiful", "lasso", 8, 16, 30, 0, { group: "specialist", specialist: "specialistWeapon.lasso", reload: 2, note: ["Entanglement location, penalties and escape tests use the Core lasso procedure and are resolved manually.", "Miejsce splątania, kary i testy uwolnienia korzystają z procedury lassa z zasad podstawowych i są rozstrzygane ręcznie."] }),
	ranged("long-bow", "Long Bow", "Łuk długi", P(15), 90, "average", "long-bow", 32, 64, 300, 3, { group: "specialist", specialist: "specialistWeapon.longBow", ammunition: "arrow", handedness: "two" }),
	ranged("normal-bow", "Normal Bow", "Łuk zwykły", P(11), 80, "common", "normal-bow", 24, 48, 250, 3, { ammunition: "arrow", handedness: "two" }),
	ranged("repeating-crossbow", "Repeating Crossbow", "Kusza powtarzalna", P(100), 150, "veryRare", "repeating-crossbow", 32, "-", 100, 1, { group: "specialist", specialist: "specialistWeapon.repeatingCrossbow", ammunition: "bolt", handedness: "two", shots: 2, magazine: 10, magazineReload: 8 }),
	ranged("short-bow", "Short Bow", "Łuk krótki", P(7), 75, "common", "short-bow", 16, 32, 150, 3, { ammunition: "arrow", handedness: "two" }),
	ranged("sling", "Sling", "Proca", P(0, 2), 10, "common", "sling", 24, 36, 150, 3, { group: "specialist", specialist: "specialistWeapon.sling" }),
	ranged("spear-thrown", "Spear (thrown)", "Włócznia (rzucana)", P(0, 35), 50, "common", "spear", 4, 8, 25, "character", { imageKey: "spear", note: ["This is the thrown mode of the separately listed melee Spear.", "To tryb rzucany osobno występującej włóczni do walki wręcz."] }),
	ranged("staff-sling", "Staff Sling", "Proca drzewcowa", P(0, 6), 30, "rare", "staff-sling", 24, 36, 200, 4, { group: "specialist", specialist: "specialistWeapon.staffSling", handedness: "two", reload: 1 }),
	ranged("throwing-axe", "Throwing Axe", "Toporek do rzucania", P(5), 40, "average", "throwing-axe", 4, 8, 20, "character", { group: "specialist", specialist: "specialistWeapon.throwing" }),
	ranged("throwing-knife", "Throwing Knife", "Nóż do rzucania", P(4), 10, "average", "throwing-knife", 4, 8, 20, "character", { group: "specialist", specialist: "specialistWeapon.throwing" }),
	ranged("throwing-warhammer", "Warhammer (thrown)", "Młot (rzucany)", P(8), 75, "scarce", "improvised-thrown", 2, 6, 10, "character", { imageKey: "warhammer", group: "improvised", note: ["The Consumer Guide lists this among missile weapons but the Missile Weapon Chart has no dedicated row; the authored ranges use the Core improvised-missile profile.", "Poradnik Konsumenta wymienia młot wśród broni strzeleckiej, lecz tabela broni strzeleckiej nie ma osobnego wiersza; zapisane zasięgi używają profilu improwizowanego pocisku."] }),
	ranged("blunderbuss", "Blunderbuss", "Rusznica", P(75), 50, "veryRare", "blunderbuss", 24, 48, 250, 3, { group: "specialist", specialist: "specialistWeapon.firearms", ammunition: "firearmLoad", reload: 3, note: misfireNote() }),
	ranged("bomb", "Bomb", "Bomba", P(75), 20, "veryRare", "bomb", 2, 6, 10, 6, { group: "specialist", specialist: "specialistWeapon.bomb", note: ["Uses the Core blast-radius, miss-location and misfire procedures; those steps are resolved manually.", "Używa procedur promienia wybuchu, miejsca upadku po chybieniu i niewypału z zasad podstawowych; te kroki są rozstrzygane ręcznie."] }),
	ranged("pistol", "Pistol", "Pistolet", P(150), 25, "veryRare", "pistol", 8, 16, 50, 3, { group: "specialist", specialist: "specialistWeapon.firearms", ammunition: "firearmLoad", reload: 2, note: misfireNote() }),
]);

const EQUIPMENT = Object.freeze([
	// Ammunition and weapon accessories (Consumer Guide p. 295).
	equipment("arrows", "Arrows (5)", "Strzały (5)", "ammunition", P(0, 30), 10, "common", { quantity: 5, ammunition: "arrow", imageSubject: "a tied bundle of five medieval war arrows" }),
	equipment("crossbow-bolts", "Crossbow Bolts (5)", "Bełty do kuszy (5)", "ammunition", P(2), 10, "average", { quantity: 5, ammunition: "bolt", imageSubject: "a tied bundle of five short heavy crossbow bolts" }),
	equipment("firearm-balls", "Firearm Balls (10)", "Kule do broni palnej (10)", "ammunition", P(1), 10, "scarce", { quantity: 10, imageSubject: "ten rough cast lead firearm balls in a small open leather pouch" }),
	equipment("gunpowder-shot", "Gunpowder (shot)", "Proch strzelniczy (ładunek)", "ammunition", P(5), 1, "rare", { imageSubject: "one measured black-powder charge in a small folded paper cartridge" }),
	equipment("quiver", "Quiver for 30 Arrows", "Kołczan na 30 strzał", "ammunition", P(15), 15, "common", { container: true, quickAmmunition: "arrow", capacity: 30, imageSubject: "an empty worn leather arrow quiver with shoulder strap" }),
	equipment("firearm-load", "Firearm Load", "Ładunek broni palnej", "ammunition", P(5, 2), 2, "scarce", { ammunition: "firearmLoad", derived: true, imageSubject: "a single lead ball beside one measured black-powder paper charge", note: ["System-ready combined load: one ball plus one printed gunpowder shot. The price and Encumbrance are the sum of those two Core entries.", "Systemowy kompletny ładunek: jedna kula oraz jeden tabelaryczny ładunek prochu. Cena i Obciążenie są sumą tych dwóch pozycji z zasad podstawowych."] }),

	// Subsistence goods; room, stabling and fodder services are excluded.
	equipment("prepared-food-day", "Prepared Food (one day)", "Jedzenie na jeden dzień (gotowy posiłek)", "subsistence", P(0, 0, 0, "3–7 SS", "3–7 SS"), 10, "plentiful", { imageSubject: "a humble day ration of dark bread, cheese and onion wrapped in cloth" }),
	equipment("iron-rations-week", "Iron Rations (one week)", "Żelazne racje (na tydzień)", "subsistence", P(3), 50, "common", { imageSubject: "a tightly wrapped week of hard travel rations, dried meat and hardtack" }),
	equipment("ale-pint", "Ale (pint)", "Piwo (pół litra)", "subsistence", P(0, 0, 9), 2, "plentiful", { imageSubject: "a squat stoneware pint mug of dark ale" }),
	equipment("house-wine", "House Wine (bottle)", "Domowe wino (butelka)", "subsistence", P(0, 4), 5, "common", { imageSubject: "a plain stoppered bottle of rough red table wine" }),
	equipment("good-wine", "Good Wine (bottle)", "Dobre wino (butelka)", "subsistence", P(0, 25), 5, "average", { imageSubject: "a fine sealed green-glass bottle of quality wine" }),
	equipment("spirit-bottle", "Spirit (bottle)", "Wódka (butelka)", "subsistence", P(0, 10), 5, "average", { imageSubject: "a small heavy glass bottle of clear distilled spirit" }),

	// Clothing (Consumer Guide p. 293). Worn clothing is weightless by Core rule;
	// the listed Encumbrance remains the carried value on the Item definition.
	equipment("belt", "Belt", "Pas", "clothing", P(0, 10), 1, "plentiful", clothing("a sturdy late-medieval leather belt with plain iron buckle")),
	equipment("breeches", "Breeches", "Bryczesy", "clothing", P(2), 4, "plentiful", clothing("a folded pair of durable woollen breeches")),
	equipment("clerical-robes", "Clerical Robes", "Szaty kapłańskie", "clothing", P(13), 20, "average", clothing("a folded set of austere late-medieval clerical robes with no religious symbol")),
	equipment("cloak", "Cloak", "Peleryna", "clothing", P(5), 10, "plentiful", clothing("a heavy folded wool cloak with simple bronze clasp")),
	equipment("dress", "Dress", "Suknia", "clothing", P(7), 6, "plentiful", clothing("a practical late-medieval wool dress laid neatly folded")),
	equipment("silk-handkerchief", "Handkerchief (silk)", "Chusteczka do nosa (jedwabna)", "clothing", P(4), 0, "common", clothing("a small folded square of fine dyed silk")),
	equipment("wide-brimmed-hat", "Hat (wide-brimmed)", "Kapelusz z szerokim rondem", "clothing", P(5), 5, "plentiful", clothing("a worn wide-brimmed felt hat with a modest feather")),
	equipment("simple-hat", "Hat (simple)", "Kapelusz zwyczajny", "clothing", P(0, 10), 1, "plentiful", clothing("a plain soft felt cap")),
	equipment("hood-mask", "Hood / Mask", "Kaptur / Maska", "clothing", P(0, 25), 2, "common", clothing("a folded dark cloth hood with an attached simple face mask")),
	equipment("jacket-doublet", "Jacket / Doublet", "Kubrak przeszywany", "clothing", P(6), 4, "plentiful", clothing("a practical quilted late-medieval doublet")),
	equipment("leather-boots", "Leather Boots", "Buty skórzane (długie)", "clothing", P(9), 10, "common", clothing("a pair of tall scuffed leather boots")),
	equipment("leather-shoes", "Leather Shoes", "Buty", "clothing", P(6), 5, "plentiful", clothing("a pair of simple low leather shoes")),
	equipment("overcoat", "Overcoat", "Płaszcz ciężki", "clothing", P(10), 15, "plentiful", clothing("a thick folded wool overcoat for cold travel")),
	equipment("riding-boots", "Riding Boots (with spurs)", "Buty jeździeckie (z ostrogami)", "clothing", P(12), 12, "average", clothing("a pair of high riding boots fitted with plain iron spurs")),
	equipment("scarf", "Scarf / Neckerchief", "Chusta na szyję", "clothing", P(0, 6), 0, "plentiful", clothing("a rolled wool neck scarf")),
	equipment("shirt", "Shirt", "Koszula", "clothing", P(2), 2, "plentiful", clothing("a folded off-white linen shirt")),
	equipment("smock", "Smock", "Chałat", "clothing", P(0, 50), 3, "plentiful", clothing("a loose work smock of coarse undyed cloth")),
	equipment("tunic", "Tunic", "Tunika", "clothing", P(5), 4, "plentiful", clothing("a folded sturdy wool tunic")),

	// Carrying equipment.
	equipment("backpack", "Backpack (holds 250)", "Plecak (pojemność 250)", "carrying", P(0, 30), 20, "plentiful", container("a rugged leather-and-canvas backpack with straps")),
	equipment("leather-flask", "Leather Flask (pint)", "Manierka skórzana (pół litra)", "carrying", P(0, 15), 5, "average", { imageSubject: "a small stitched leather drinking flask with stopper" }),
	equipment("metal-flask", "Metal Flask (pint)", "Manierka metalowa (pół litra)", "carrying", P(0, 50), 15, "scarce", { imageSubject: "a dented tinned-metal drinking flask with stopper" }),
	equipment("leather-tube-case", "Leather Tube Case", "Tuba skórzana", "carrying", P(1), 2, "scarce", container("a capped cylindrical leather map and document case")),
	equipment("pouch", "Pouch", "Sakiewka", "carrying", P(0, 5), 1, "plentiful", container("a small drawstring leather belt pouch")),
	equipment("purse", "Purse (holds 100 coins)", "Sakiewka (100 monet)", "carrying", P(0, 2), 1, "plentiful", container("a compact drawstring coin purse with a few brass coins")),
	equipment("sack", "Sack (holds 200)", "Worek (pojemność 200)", "carrying", P(0, 16), 7, "plentiful", container("an empty coarse burlap sack tied with cord")),
	equipment("saddlebag", "Saddlebag (holds 150)", "Sakwa (pojemność 150)", "carrying", P(2), 5, "average", container("a pair of worn leather saddlebags joined by straps")),
	equipment("slingbag", "Slingbag (holds 200)", "Torba na ramię (pojemność 200)", "carrying", P(0, 6), 5, "plentiful", container("a simple cross-body canvas sling bag")),
	equipment("waterskin", "Water Skin (gallon)", "Bukłak na wodę (5 l)", "carrying", P(0, 8), 1, "plentiful", { imageSubject: "a full goatskin water bag with wooden stopper and shoulder cord" }),

	// Household and personal equipment.
	equipment("blanket", "Blanket", "Koc", "household", P(2), 10, "plentiful", { imageSubject: "a rolled coarse wool blanket bound with leather straps" }),
	equipment("clothes-pegs", "Clothes Pegs (dozen)", "Spinacze do bielizny (tuzin)", "household", P(0, 2), 2, "common", { imageSubject: "a dozen simple hand-carved wooden clothes pegs" }),
	equipment("cooking-pot", "Cooking Pot", "Garnek kucharski", "household", P(1), 20, "plentiful", { imageSubject: "a blackened iron cooking pot with bail handle" }),
	equipment("wooden-cutlery", "Cutlery Set (wood)", "Sztućce drewniane (komplet)", "household", P(0, 5), 2, "plentiful", { imageKey: "cutlery-set", imageSubject: "a humble medieval spoon, knife and two-pronged fork set" }),
	equipment("metal-cutlery", "Cutlery Set (metal)", "Sztućce metalowe (komplet)", "household", P(3), 4, "common", { imageKey: "cutlery-set", imageSubject: "a humble medieval spoon, knife and two-pronged fork set" }),
	equipment("silver-cutlery", "Cutlery Set (silver)", "Sztućce srebrne (komplet)", "household", P(15), 3, "scarce", { imageKey: "cutlery-set", imageSubject: "a humble medieval spoon, knife and two-pronged fork set" }),
	equipment("bone-dice", "Dice (bone, pair)", "Kości do gry (para)", "household", P(0, 6), 0, "plentiful", { imageSubject: "a pair of small uneven hand-carved bone dice" }),
	equipment("earthenware-jug", "Jug (earthenware)", "Dzban gliniany", "household", P(0, 3, 6), 10, "plentiful", { imageSubject: "a squat glazed earthenware jug with handle" }),
	equipment("kettle", "Kettle (holds a pint)", "Kociołek (pół litra)", "household", P(0, 30), 10, "plentiful", { imageSubject: "a small blackened iron camp kettle with lid" }),
	equipment("kindling", "Kindling / Firewood (bundle)", "Drewno na opał (wiązka)", "household", P(0, 2), 5, "plentiful", { imageSubject: "a tied bundle of dry split kindling and twigs" }),
	equipment("flock-mattress", "Mattress (flock)", "Materac z włosia", "household", P(8), 400, "average", { imageKey: "mattress", imageSubject: "a rolled striped ticking mattress tied with cord" }),
	equipment("feather-mattress", "Mattress (feather)", "Materac z pierza", "household", P(12), 350, "scarce", { imageKey: "mattress", imageSubject: "a rolled striped ticking mattress tied with cord" }),
	equipment("playing-cards", "Pack of Cards", "Talia kart", "household", P(1), 1, "plentiful", { imageSubject: "a worn deck of hand-painted medieval playing cards, no readable text" }),
	equipment("pewter-tankard", "Tankard (pewter)", "Kufel cynowy", "household", P(1), 5, "plentiful", { imageSubject: "a dented pewter tankard with hinged lid" }),
	equipment("tinderbox", "Tinderbox", "Hubka i krzesiwo", "household", P(0, 30), 5, "plentiful", { imageSubject: "an open small wooden tinderbox with flint, steel and char cloth" }),

	// Illumination.
	equipment("tallow-candles", "Candles, tallow (dozen; 3-hour burn)", "Świece łojowe (tuzin; 3 godz.)", "illumination", P(0, 6), 5, "plentiful", { imageKey: "candles", imageSubject: "a tied bundle of twelve rough handmade candles" }),
	equipment("wax-candles", "Candles, wax (dozen; 4-hour burn)", "Świece woskowe (tuzin; 4 godz.)", "illumination", P(0, 36), 5, "average", { imageKey: "candles", imageSubject: "a tied bundle of twelve rough handmade candles" }),
	equipment("fuel-oil", "Fuel Oil (pint)", "Olej (pół litra)", "illumination", P(0, 8), 5, "plentiful", { imageSubject: "a sealed clay flask of lamp oil" }),
	equipment("pot-lamp", "Lamp (pot)", "Lampa", "illumination", P(0, 5), 20, "plentiful", { imageSubject: "a simple shallow clay oil lamp with a short wick" }),
	equipment("lantern", "Lantern", "Latarnia", "illumination", P(12), 20, "average", { imageSubject: "a sturdy late-medieval iron lantern with horn panes" }),
	equipment("storm-lantern", "Storm Lantern", "Latarnia sztormowa", "illumination", P(20), 30, "scarce", { imageSubject: "a sealed rugged brass storm lantern with protected panes" }),
	equipment("torch", "Torch", "Pochodnia", "illumination", P(0, 1), 5, "plentiful", { imageSubject: "an unlit pitch-soaked cloth torch on a wooden stave" }),

	// Musical instruments.
	equipment("coach-horn", "Coach Horn", "Róg", "instrument", P(10), 30, "average", { imageSubject: "a curved brass coach horn" }),
	equipment("drum", "Drum", "Bęben", "instrument", P(0, 30), 50, "average", { imageSubject: "a small rope-tensioned wooden field drum with two sticks" }),
	equipment("flute", "Flute", "Flet", "instrument", P(20), 10, "rare", { imageSubject: "a finely carved transverse wooden flute" }),
	equipment("small-harp", "Harp (small)", "Harfa mała", "instrument", P(20), 50, "rare", { imageSubject: "a small portable medieval lap harp" }),
	equipment("harpsichord", "Harpsichord", "Klawikord", "instrument", P(250), 1200, "rare", { imageSubject: "a compact ornate late-Renaissance harpsichord shown alone" }),
	equipment("lute", "Lute", "Lutnia", "instrument", P(80), 30, "scarce", { imageSubject: "a worn wooden Renaissance lute" }),
	equipment("mandolin", "Mandolin", "Mandolina", "instrument", P(23), 15, "scarce", { imageSubject: "a small early mandolin with worn wooden body" }),
	equipment("mouth-harp", "Mouth Harp", "Harmonijka ustna", "instrument", P(0, 8), 1, "average", { imageSubject: "a small iron jaw harp" }),
	equipment("recorder", "Recorder", "Flet klasyczny", "instrument", P(3), 5, "average", { imageSubject: "a simple carved wooden recorder" }),
	equipment("tambourine", "Tambourine", "Tamburyn", "instrument", P(1), 5, "average", { imageSubject: "a wooden tambourine with small dark metal jingles" }),
	equipment("viol", "Viol", "Wiola", "instrument", P(25), 30, "average", { imageSubject: "a small Renaissance viol with bow" }),

	// Tools.
	equipment("artisan-tools", "Artisan's Trade Tools (set)", "Narzędzia rzemieślnicze", "tools", P(50), 40, "rare", { imageSubject: "a compact roll of varied late-medieval artisan hand tools" }),
	equipment("base-metal-ingot", "Base Metal Ingot (2 lb)", "Surowiec metalowy (gąska)", "tools", P(0, 26), 20, "average", { imageSubject: "a rough two-pound ingot of dull base metal" }),
	equipment("coin-dies", "Coin Dies (pair of blanks)", "Forma do monet (bez wzoru)", "tools", P(10), 5, "rare", { imageSubject: "a matched pair of blank hardened-steel coin dies" }),
	equipment("chain-yard", "Chain (yard)", "Łańcuch (metr)", "tools", P(0, 30), 50, "average", { imageSubject: "a coiled yard of heavy hand-forged iron chain" }),
	equipment("crowbar", "Crowbar", "Łom", "tools", P(5), 20, "average", { imageSubject: "a straight hand-forged iron crowbar" }),
	equipment("fish-hook-line", "Fish Hook and Line", "Haczyk na ryby i linka", "tools", P(0, 3), 2, "common", { imageSubject: "a bone-and-iron fish hook with coiled line and small float" }),
	equipment("grappling-hook", "Grappling Hook", "Hak", "tools", P(4), 20, "average", { imageSubject: "a four-pronged iron grappling hook with a short length of rope" }),
	equipment("iron-spike", "Iron Spike (12 inches)", "Gwóźdź żelazny (12 cali)", "tools", P(0, 10), 5, "common", { imageSubject: "a single foot-long hand-forged iron spike" }),
	equipment("engraving-tools", "Engraving Tools", "Narzędzia grawerskie", "tools", P(50), 20, "rare", { imageSubject: "a small leather roll of fine gravers and engraving tools" }),
	equipment("lock-picks", "Lock Pick Tools", "Wytrychy", "tools", P(10), 20, "average", { imageSubject: "a discreet leather case of hand-forged lock picks and tension tools" }),
	equipment("magnifying-glass", "Magnifying Glass", "Szkło powiększające", "tools", P(75), 5, "veryRare", { imageSubject: "a rare small convex magnifying lens in a brass handle" }),
	equipment("manacles", "Manacles (pair)", "Kajdany (para)", "tools", P(5), 20, "average", { imageSubject: "a pair of heavy iron wrist manacles joined by short chain" }),
	equipment("man-trap", "Man Trap", "Potrzask", "tools", P(8), 100, "average", { imageSubject: "a brutal open iron jaw trap with chain, no blood" }),
	equipment("medical-instruments", "Medical Instruments", "Instrumenty medyczne", "tools", P(50), 50, "rare", { imageSubject: "a leather surgeon's roll of forceps, probes, saw and needles, clean and bloodless" }),
	equipment("metalworking-tools", "Metal-working Tools", "Narzędzia kowalskie", "tools", P(50), 100, "rare", { imageSubject: "a compact set of heavy blacksmith tongs, hammers and chisels, no forge" }),
	equipment("navigator-tools", "Navigator's Tools", "Przyrządy nawigacyjne", "tools", P(50), 20, "rare", { imageSubject: "a mariner's brass dividers, simple astrolabe and measuring rule" }),
	equipment("navigation-charts", "Navigational Charts (printed)", "Mapy nawigacyjne (drukowane)", "tools", P(25), 5, "rare", { imageSubject: "a rolled set of old printed coastal navigation charts with no readable text" }),
	equipment("pole-yard", "Pole (yard)", "Tyczka (metr)", "tools", P(0, 1, 6), 10, "plentiful", { imageSubject: "a plain one-yard hardwood pole" }),
	equipment("rope-yard", "Rope (yard)", "Sznur (metr)", "tools", P(0, 5), 10, "average", { imageSubject: "a neatly coiled yard of thick hemp rope" }),
	equipment("saw", "Saw", "Piła", "tools", P(7), 10, "common", { imageSubject: "a hand-forged frame saw with wooden handle" }),
	equipment("wire-snare", "Snare (wire)", "Sidła (metalowe)", "tools", P(1), 5, "common", { imageSubject: "a coiled wire hunting snare with trigger peg" }),
	equipment("iron-spade", "Spade (iron edge)", "Łopata (żelazna)", "tools", P(0, 25), 20, "common", { imageSubject: "a wooden spade reinforced with a dark iron cutting edge" }),
	equipment("wooden-wedge", "Wooden Wedge", "Klin drewniany", "tools", P(0, 0, 8), 2, "plentiful", { imageSubject: "a single scarred hardwood splitting wedge" }),

	// Reading and writing.
	equipment("illuminated-book", "Book (illuminated)", "Książka iluminowana", "writing", P(350), 50, "rare", { imageSubject: "a closed richly illuminated manuscript with brass clasps, no readable title" }),
	equipment("printed-book", "Book (printed)", "Książka (drukowana)", "writing", P(40), 35, "scarce", { imageSubject: "an early printed book in worn leather binding, no readable title" }),
	equipment("writing-equipment", "Writing Equipment", "Przybory piśmiennicze", "writing", P(10), 5, "average", { imageSubject: "a quill, small ink horn, sealing wax and penknife arranged together" }),
	equipment("paper-sheets", "Paper (12 sheets)", "Papier (12 kartek)", "writing", P(0, 12), 0, "rare", { polishOnly: true, imageSubject: "a neat stack of twelve handmade rag-paper sheets" }),
	equipment("parchment-sheets", "Parchment (12 sheets)", "Pergamin (12 kartek)", "writing", P(0, 0, 12), 0, "scarce", { polishOnly: true, imageSubject: "a stack of twelve creamy prepared parchment sheets" }),
]);

const ALL = Object.freeze([...ARMOUR, ...MELEE, ...RANGED, ...EQUIPMENT]);

export function coreEquipmentDefinitions(language = "en") {
	const lang = normalizeLanguage(language);
	return Object.freeze(ALL
		.filter((entry) => lang === "pl" || entry.polishOnly !== true)
		.map((entry) => localizedDefinition(entry, lang)));
}

export function coreEquipmentItemSources(language = "en") {
	const lang = normalizeLanguage(language);
	return Object.freeze(coreEquipmentDefinitions(lang).map((entry) => {
		const source = {
			name: entry.name,
			type: entry.type,
			img: `${IMAGE_ROOT}/${entry.imageKey}.webp`,
			system: localizedSystem(entry, lang),
			effects: [],
			flags: {
				wfrp1ed: {
					coreCatalog: {
						version: CORE_CATALOG_VERSION,
						kind: "equipment",
						catalogId: entry.catalogId,
						category: entry.category,
						englishName: entry.englishName,
						polishName: entry.polishName,
						polishOnly: entry.polishOnly === true,
						derived: entry.derived === true,
						mechanics: entry.mechanics,
						source: {
							english: entry.sourceEnglish,
							polish: entry.sourcePolish,
						},
					},
				},
			},
		};
		return Object.freeze(source);
	}));
}

/** Original-image generation manifest. Language packs share one asset. */
export function coreEquipmentImageDefinitions() {
	const byKey = new Map();
	for (const entry of ALL) {
		if (!byKey.has(entry.imageKey)) {
			byKey.set(entry.imageKey, Object.freeze({
				imageKey: entry.imageKey,
				subject: entry.imageSubject,
			}));
		}
	}
	return Object.freeze([...byKey.values()]);
}

function armour(id, englishName, polishName, price, encumbrance, availability, armourClass, piece, armourPoints, coverage, options = {}) {
	return definition(id, englishName, polishName, "armour", "armour", price, encumbrance, availability, {
		...options,
		imageSubject: options.imageSubject ?? armourImageSubject(id, englishName),
		system: {
			rulesId: "",
			armourClass,
			piece,
			armourPoints,
			coverage: Object.fromEntries(["head", "body", "rightArm", "leftArm", "rightLeg", "leftLeg"].map((area) => [area, coverage.includes(area)])),
			parry: { suitable: options.parry === true, bonus: options.parryBonus ?? 0 },
		},
		mechanics: options.note ? "field-driven-with-manual-note" : "field-driven",
		sourceEnglish: "Core Consumer Guide, Armour p. 295; protection rules pp. 121-122",
		sourcePolish: "Core Poradnik Konsumenta, Pancerz s. 295; zasady ochrony s. 121-122",
	});
}

function melee(id, englishName, polishName, price, encumbrance, availability, weaponClass, options = {}) {
	return weapon(id, englishName, polishName, "melee", price, encumbrance, availability, {
		...options,
		weaponClass,
		imageSubject: options.imageSubject ?? weaponImageSubject(englishName),
		system: {
			kind: "melee",
			group: options.group ?? "ordinary",
			specialistSkillId: options.specialist ?? "",
			handedness: options.handedness ?? "one",
			parry: { suitable: options.parry === true, bonus: options.parryBonus ?? 0 },
			optionalModifiers: options.modifiers ?? M(),
			range: { short: "0", long: "0", max: "0" },
			effectiveStrengthMode: "fixed",
			effectiveStrength: 0,
			ammunitionType: "none",
			ammunitionCustomId: "",
			firingCycle: { reloadRounds: 0, shotsPerFireRound: 1, magazineCapacity: 0, magazineReloadRounds: 0 },
		},
	});
}

function ranged(id, englishName, polishName, price, encumbrance, availability, weaponClass, short, long, max, strength, options = {}) {
	const characterStrength = strength === "character";
	return weapon(id, englishName, polishName, "ranged", price, encumbrance, availability, {
		...options,
		weaponClass,
		imageSubject: options.imageSubject ?? weaponImageSubject(englishName),
		system: {
			kind: "ranged",
			group: options.group ?? "ordinary",
			specialistSkillId: options.specialist ?? "",
			handedness: options.handedness ?? "one",
			parry: { suitable: false, bonus: 0 },
			optionalModifiers: M(),
			range: { short: String(short), long: String(long), max: String(max) },
			effectiveStrengthMode: characterStrength ? "character" : "fixed",
			effectiveStrength: characterStrength ? 0 : strength,
			ammunitionType: options.ammunition ?? "none",
			ammunitionCustomId: "",
			firingCycle: {
				reloadRounds: options.reload ?? 0,
				shotsPerFireRound: options.shots ?? 1,
				magazineCapacity: options.magazine ?? 0,
				magazineReloadRounds: options.magazineReload ?? 0,
			},
		},
	});
}

function weapon(id, englishName, polishName, category, price, encumbrance, availability, options) {
	return definition(id, englishName, polishName, "weapon", category, price, encumbrance, availability, {
		...options,
		system: { rulesId: "", weaponClass: options.weaponClass, ...options.system },
		mechanics: options.note ? "field-driven-with-manual-note" : "field-driven",
		sourceEnglish: category === "melee"
			? "Core Consumer Guide, Weapons p. 295; melee descriptions/modifiers pp. 118-121"
			: "Core Consumer Guide, Weapons p. 295; missile descriptions/chart pp. 126-129",
		sourcePolish: category === "melee"
			? "Core Poradnik Konsumenta, Broń s. 295; opisy/modyfikatory walki wręcz s. 118-121"
			: "Core Poradnik Konsumenta, Broń s. 295; opisy/tabela broni strzeleckiej s. 126-129",
	});
}

function equipment(id, englishName, polishName, category, price, encumbrance, availability, options = {}) {
	const isContainer = options.container === true;
	const isAmmunition = Boolean(options.ammunition) && !isContainer;
	return definition(id, englishName, polishName, "equipment", category, price, encumbrance, availability, {
		...options,
		imageSubject: options.imageSubject ?? `one ${englishName.toLowerCase()}`,
		system: {
			referenceQuantity: options.quantity ?? 1,
			isWealth: false,
			isContainer,
			isClothing: options.clothing === true,
			containerId: "",
			equipmentKind: isAmmunition ? "ammunition" : "standard",
			ammunitionType: isAmmunition ? options.ammunition : "none",
			ammunitionCustomId: "",
			containerKind: options.quickAmmunition ? "quickAmmunition" : "standard",
			containerAmmunitionType: options.quickAmmunition ?? "none",
			containerAmmunitionCustomId: "",
			containerCapacity: options.capacity ?? 0,
		},
		mechanics: options.derived ? "derived-system-ammunition" : isAmmunition || options.quickAmmunition ? "field-driven" : "inventory",
		sourceEnglish: options.derived
			? "Derived from Core Consumer Guide Firearm Balls and Gunpowder entries, p. 295"
			: equipmentSource(category, "en"),
		sourcePolish: options.derived
			? "Pozycja pochodna z wpisów Kule do broni palnej i Proch strzelniczy, s. 295"
			: equipmentSource(category, "pl"),
	});
}

function definition(id, englishName, polishName, type, category, price, encumbrance, availability, options) {
	return Object.freeze({
		catalogId: `${type}.${id}`,
		englishName,
		polishName,
		type,
		category,
		price,
		encumbrance,
		availability,
		imageKey: options.imageKey ?? id,
		imageSubject: options.imageSubject,
		note: options.note ?? ["", ""],
		polishOnly: options.polishOnly === true,
		derived: options.derived === true,
		mechanics: options.mechanics,
		system: options.system,
		sourceEnglish: options.sourceEnglish,
		sourcePolish: options.sourcePolish,
	});
}

function localizedDefinition(entry, lang) {
	return Object.freeze({
		...entry,
		name: lang === "pl" ? entry.polishName : entry.englishName,
	});
}

function localizedSystem(entry, lang) {
	const description = lang === "pl" ? entry.note[1] : entry.note[0];
	const availability = AVAILABILITY[entry.availability]?.[lang === "pl" ? 1 : 0] ?? "";
	const system = {
		description,
		gmDescription: "",
		quantity: entry.system.referenceQuantity ?? 1,
		encumbrance: entry.encumbrance,
		price: { gc: entry.price.gc, ss: entry.price.ss, bp: entry.price.bp },
		priceFormula: lang === "pl" ? entry.price.formulaPl : entry.price.formulaEn,
		availability,
		storageLocation: "",
		state: { mode: "carried", hand: entry.type === "weapon" ? "main" : "none" },
		...entry.system,
	};
	return system;
}

function equipmentSource(category, language) {
	const page = category === "ammunition" ? 295 : category === "subsistence" || category === "clothing" ? 293 : 296;
	return language === "pl"
		? `Core Poradnik Konsumenta, s. ${page}`
		: `Core Consumer Guide, p. ${page}`;
}

function leatherNote() {
	return [
		"Leather is the Core 0/1 exception: it reduces post-Toughness damage by 1 only when 1–3 points remain; 4 or more ignores it.",
		"Skóra używa zasady 0/1: zmniejsza obrażenia po Wytrzymałości o 1 tylko wtedy, gdy pozostało 1–3; przy 4 lub więcej nie chroni.",
	];
}

function twoHandedWeapon() {
	return { group: "specialist", specialist: "specialistWeapon.twoHanded", handedness: "two", modifiers: M(-10, 0, 2, 0), parry: true };
}

function conditionalModifierNote(english, polish) {
	return [english, polish];
}

function misfireNote() {
	return [
		"Natural doubles use the Core gunpowder-weapon misfire procedure; resolve it manually.",
		"Naturalny dublet uruchamia procedurę niewypału broni prochowej z zasad podstawowych; rozstrzygaj ją ręcznie.",
	];
}

function clothing(imageSubject) {
	return {
		clothing: true,
		imageSubject,
		note: [
			"The listed Encumbrance applies while carried; worn clothing does not count toward personal Encumbrance.",
			"Podane Obciążenie obowiązuje podczas przenoszenia; ubranie noszone na sobie nie zwiększa osobistego Obciążenia.",
		],
	};
}

function container(imageSubject) {
	return { container: true, imageSubject };
}

function armourImageSubject(id, name) {
	if (id === "shield" || id === "unrimmed-shield") return `one ${name.toLowerCase()}, front face visible`;
	return `one empty ${name.toLowerCase()} armour piece, no wearer or mannequin`;
}

function weaponImageSubject(name) {
	return `one ${name.toLowerCase()} weapon, complete object visible`;
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl") ? "pl" : "en";
}

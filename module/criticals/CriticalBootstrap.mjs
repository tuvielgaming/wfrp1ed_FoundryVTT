import {
	CORE_SUDDEN_DEATH_PROVIDER_ID,
	CORE_SUDDEN_DEATH_TABLE_UUIDS,
	ensureCoreSuddenDeathTables,
	registerCoreSuddenDeathTableProtection,
	SUDDEN_DEATH_OUTCOME,
} from "./CoreSuddenDeathTables.mjs";
import { registerCriticalDamageIntegration } from "./CriticalDamageIntegration.mjs";
import { registerFatalCriticalIntegration } from "./FatalCriticalIntegration.mjs";
import {
	CRITICAL_TABLE_PROVIDER_SOURCE,
	CRITICAL_TABLE_ROLE,
	CRITICAL_TABLE_VARIANT,
	CRITICAL_VALUE_VARIANTS,
	CriticalTableRegistry,
} from "./CriticalTableRegistry.mjs";
import { SuddenDeathResolver } from "./SuddenDeathResolver.mjs";

Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED critical bootstrap requires the core system API to initialize first.",
		);
	}

	CriticalTableRegistry.registerSettings();
	registerCoreRoles();
	registerCoreProviders();
	registerCoreSuddenDeathTableProtection();
	registerCriticalDamageIntegration();
	registerFatalCriticalIntegration();

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		criticals: Object.freeze({
			roles: CRITICAL_TABLE_ROLE,
			variants: CRITICAL_TABLE_VARIANT,
			criticalValueVariants: CRITICAL_VALUE_VARIANTS,
			providerSource: CRITICAL_TABLE_PROVIDER_SOURCE,
			outcomes: Object.freeze({
				suddenDeath: SUDDEN_DEATH_OUTCOME,
			}),
			registry: CriticalTableRegistry,
			suddenDeath: SuddenDeathResolver,
		}),
	});

	/*
	 * Optional modules register providers here. Registration only advertises an
	 * available rules source; it never activates that provider for the world.
	 */
	Hooks.callAll(
		"wfrp1edRegisterCriticalTableProviders",
		CriticalTableRegistry,
	);
});

Hooks.once("ready", () => {
	if (game.user?.isGM) {
		void ensureCoreSuddenDeathTables().catch((error) => {
			console.error(
				"WFRP1ED | Unable to materialize Core Sudden Death tables.",
				error,
			);
			ui.notifications.error(
				game.i18n.lang === "pl"
					? "Nie udało się przygotować domyślnych tabel Nagłej Śmierci."
					: "Unable to prepare the default Sudden Death tables.",
			);
		});
	}
});

function registerCoreRoles() {
	const roles = [
		{
			id: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
			label: "Sudden Death",
			labels: { pl: "Nagła Śmierć" },
			variants: CRITICAL_VALUE_VARIANTS,
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_CHART,
			label: "Critical Hit Chart",
			labels: { pl: "Tabela trafień krytycznych" },
			variants: CRITICAL_VALUE_VARIANTS,
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_HEAD,
			label: "Critical Effects — Head",
			labels: { pl: "Efekty krytyczne — Głowa" },
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_BODY,
			label: "Critical Effects — Body",
			labels: { pl: "Efekty krytyczne — Korpus" },
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_ARM,
			label: "Critical Effects — Arm",
			labels: { pl: "Efekty krytyczne — Ręka" },
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_LEG,
			label: "Critical Effects — Leg",
			labels: { pl: "Efekty krytyczne — Noga" },
		},
	];

	for (const role of roles) {
		CriticalTableRegistry.registerRole(role);
	}
}

function registerCoreProviders() {
	CriticalTableRegistry.registerProvider({
		id: CORE_SUDDEN_DEATH_PROVIDER_ID,
		role: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
		label: "WFRP 1e Core — Sudden Death",
		labels: {
			pl: "WFRP 1e Core — Nagła Śmierć",
		},
		source: CRITICAL_TABLE_PROVIDER_SOURCE.CORE,
		tableUuids: CORE_SUDDEN_DEATH_TABLE_UUIDS,
	});
}

import {
	CRITICAL_TABLE_PROVIDER_SOURCE,
	CRITICAL_TABLE_ROLE,
	CriticalTableRegistry,
} from "./CriticalTableRegistry.mjs";

Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED critical bootstrap requires the core system API to initialize first.",
		);
	}

	CriticalTableRegistry.registerSettings();
	registerCoreRoles();

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		criticals: Object.freeze({
			roles: CRITICAL_TABLE_ROLE,
			providerSource: CRITICAL_TABLE_PROVIDER_SOURCE,
			registry: CriticalTableRegistry,
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

function registerCoreRoles() {
	const roles = [
		{
			id: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
			label: "Sudden Death",
			labels: { pl: "Nagła Śmierć" },
		},
		{
			id: CRITICAL_TABLE_ROLE.DETAILED_CHART,
			label: "Critical Hit Chart",
			labels: { pl: "Tabela trafień krytycznych" },
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

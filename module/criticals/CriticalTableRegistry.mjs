export const CRITICAL_TABLE_ROLE = Object.freeze({
	SUDDEN_DEATH: "critical.suddenDeath",
	DETAILED_CHART: "critical.detailed.chart",
	DETAILED_HEAD: "critical.detailed.head",
	DETAILED_BODY: "critical.detailed.body",
	DETAILED_ARM: "critical.detailed.arm",
	DETAILED_LEG: "critical.detailed.leg",
});

export const CRITICAL_TABLE_PROVIDER_SOURCE = Object.freeze({
	CORE: "core",
	MODULE: "module",
});

const SETTINGS_NAMESPACE = "wfrp1ed";
const SETTINGS_KEY = "criticalTableConfiguration";
const CONFIG_VERSION = 1;

/**
 * Registry and world-level selection boundary for WFRP critical tables.
 *
 * Resolution precedence is intentionally fixed:
 *
 * 1. explicit world RollTable override;
 * 2. explicitly selected installed provider;
 * 3. audited WFRP1ED Core provider.
 *
 * Registering a provider never activates it. Modules may advertise alternative
 * tables without silently changing campaign mechanics.
 */
export class CriticalTableRegistry {
	static #roles = new Map();
	static #providers = new Map();
	static #coreProviders = new Map();
	static #settingsRegistered = false;
	static #warned = new Set();

	static registerSettings() {
		if (this.#settingsRegistered) {
			return;
		}

		game.settings.register(
			SETTINGS_NAMESPACE,
			SETTINGS_KEY,
			{
				name: "WFRP1ED critical table configuration",
				scope: "world",
				config: false,
				type: Object,
				default: {
					version: CONFIG_VERSION,
					roles: {},
				},
			},
		);

		this.#settingsRegistered = true;
	}

	static registerRole(definition = {}) {
		const role = normalizeRole(definition);

		if (this.#roles.has(role.id)) {
			throw new Error(
				`Critical table role '${role.id}' is already registered.`,
			);
		}

		this.#roles.set(role.id, role);
		return role;
	}

	static role(roleId) {
		return this.#roles.get(normalizeId(roleId)) ?? null;
	}

	static roles() {
		return Object.freeze([...this.#roles.values()]);
	}

	static roleLabel(roleOrId) {
		const role = typeof roleOrId === "string"
			? this.role(roleOrId)
			: roleOrId;

		return localizedLabel(role, roleOrId);
	}

	static registerProvider(definition = {}) {
		const provider = normalizeProvider(definition);
		const role = this.role(provider.role);

		if (!role) {
			throw new Error(
				`Critical table provider '${provider.id}' targets unknown role '${provider.role}'.`,
			);
		}

		const providers = this.#providersForRole(provider.role);

		if (providers.has(provider.id)) {
			throw new Error(
				`Critical table provider '${provider.id}' is already registered for '${provider.role}'.`,
			);
		}

		providers.set(provider.id, provider);

		if (provider.source === CRITICAL_TABLE_PROVIDER_SOURCE.CORE) {
			if (this.#coreProviders.has(provider.role)) {
				throw new Error(
					`Critical table role '${provider.role}' already has a Core provider.`,
				);
			}

			this.#coreProviders.set(provider.role, provider.id);
		}

		return provider;
	}

	static provider(roleId, providerId) {
		return this.#providers
			.get(normalizeId(roleId))
			?.get(normalizeId(providerId)) ?? null;
	}

	static providers(roleId) {
		const providers = this.#providers.get(normalizeId(roleId));

		return Object.freeze(
			providers ? [...providers.values()] : [],
		);
	}

	static providerLabel(providerOrId, roleId = "") {
		const provider = typeof providerOrId === "string"
			? this.provider(roleId, providerOrId)
			: providerOrId;

		return localizedLabel(provider, providerOrId);
	}

	static isProviderAvailable(providerOrRole, providerId = "") {
		const provider = typeof providerOrRole === "string"
			? this.provider(providerOrRole, providerId)
			: providerOrRole;

		if (!provider) {
			return false;
		}

		if (provider.source === CRITICAL_TABLE_PROVIDER_SOURCE.CORE) {
			return true;
		}

		return game.modules?.get(provider.packageId)?.active === true;
	}

	static configuration() {
		this.#assertSettingsRegistered();
		return normalizeConfiguration(
			game.settings.get(
				SETTINGS_NAMESPACE,
				SETTINGS_KEY,
			),
		);
	}

	static configuredRole(roleId) {
		const id = this.#assertRole(roleId).id;
		const configuration = this.configuration();

		return foundry.utils.deepFreeze(
			foundry.utils.deepClone(
				configuration.roles[id] ?? emptyRoleConfiguration(),
			),
		);
	}

	static async selectProvider(roleId, providerId = "") {
		this.#assertGM();
		const role = this.#assertRole(roleId);
		const normalizedProviderId = normalizeId(providerId);

		if (normalizedProviderId) {
			const provider = this.provider(role.id, normalizedProviderId);

			if (!provider) {
				throw new Error(
					`Unknown critical table provider '${normalizedProviderId}' for '${role.id}'.`,
				);
			}
		}

		return this.#updateRoleConfiguration(role.id, {
			providerId: normalizedProviderId,
		});
	}

	static async setWorldOverride(roleId, tableUuid = "") {
		this.#assertGM();
		const role = this.#assertRole(roleId);
		const normalizedUuid = String(tableUuid ?? "").trim();

		if (normalizedUuid) {
			await assertRollTableUuid(normalizedUuid);
		}

		return this.#updateRoleConfiguration(role.id, {
			worldTableUuid: normalizedUuid,
		});
	}

	static async resetRole(roleId) {
		this.#assertGM();
		const role = this.#assertRole(roleId);
		const configuration = this.configuration();

		delete configuration.roles[role.id];
		return this.#saveConfiguration(configuration);
	}

	/**
	 * Resolve the active RollTable for one stable critical role.
	 *
	 * Invalid or unavailable configured choices are skipped with a GM warning;
	 * resolution continues to the next fallback layer. A missing Core provider
	 * is a hard error because the campaign would otherwise have no deterministic
	 * rules fallback.
	 */
	static async resolve(roleId) {
		const role = this.#assertRole(roleId);
		const configured = this.configuredRole(role.id);

		if (configured.worldTableUuid) {
			const table = await resolveRollTable(configured.worldTableUuid);

			if (table) {
				return freezeResolution({
					role: role.id,
					source: "world-override",
					providerId: "",
					table,
				});
			}

			this.#warnOnce(
				`${role.id}:world:${configured.worldTableUuid}`,
				`Configured world critical RollTable '${configured.worldTableUuid}' for '${role.id}' is unavailable. Falling back.`,
			);
		}

		if (configured.providerId) {
			const provider = this.provider(
				role.id,
				configured.providerId,
			);

			if (provider && this.isProviderAvailable(provider)) {
				const table = await resolveRollTable(provider.tableUuid);

				if (table) {
					return freezeResolution({
						role: role.id,
						source: "provider",
						providerId: provider.id,
						table,
					});
				}
			}

			this.#warnOnce(
				`${role.id}:provider:${configured.providerId}`,
				`Configured critical provider '${configured.providerId}' for '${role.id}' is unavailable. Falling back to Core.`,
			);
		}

		const coreProviderId = this.#coreProviders.get(role.id);
		const coreProvider = coreProviderId
			? this.provider(role.id, coreProviderId)
			: null;

		if (!coreProvider) {
			throw new Error(
				`Critical table role '${role.id}' has no registered WFRP1ED Core fallback provider.`,
			);
		}

		const coreTable = await resolveRollTable(coreProvider.tableUuid);

		if (!coreTable) {
			throw new Error(
				`WFRP1ED Core critical table '${coreProvider.tableUuid}' for '${role.id}' is unavailable.`,
			);
		}

		return freezeResolution({
			role: role.id,
			source: "core",
			providerId: coreProvider.id,
			table: coreTable,
		});
	}

	static snapshot() {
		const roles = this.roles().map((role) => ({
			...role,
			providers: this.providers(role.id).map((provider) => ({
				...provider,
				available: this.isProviderAvailable(provider),
				core: this.#coreProviders.get(role.id) === provider.id,
			})),
			configured: this.configuredRole(role.id),
		}));

		return foundry.utils.deepFreeze({
			version: 1,
			roles,
		});
	}

	static #providersForRole(roleId) {
		const id = normalizeId(roleId);
		let providers = this.#providers.get(id);

		if (!providers) {
			providers = new Map();
			this.#providers.set(id, providers);
		}

		return providers;
	}

	static #assertRole(roleId) {
		const role = this.role(roleId);

		if (!role) {
			throw new Error(
				`Unknown critical table role '${String(roleId ?? "")}'.`,
			);
		}

		return role;
	}

	static #assertSettingsRegistered() {
		if (!this.#settingsRegistered) {
			throw new Error(
				"Critical table settings have not been registered yet.",
			);
		}
	}

	static #assertGM() {
		if (!game.user?.isGM) {
			throw new Error(
				"Only a GM may change WFRP critical table configuration.",
			);
		}
	}

	static async #updateRoleConfiguration(roleId, patch) {
		const configuration = this.configuration();
		configuration.roles[roleId] = {
			...emptyRoleConfiguration(),
			...(configuration.roles[roleId] ?? {}),
			...patch,
		};

		return this.#saveConfiguration(configuration);
	}

	static async #saveConfiguration(configuration) {
		const normalized = normalizeConfiguration(configuration);
		await game.settings.set(
			SETTINGS_NAMESPACE,
			SETTINGS_KEY,
			normalized,
		);

		return foundry.utils.deepFreeze(
			foundry.utils.deepClone(normalized),
		);
	}

	static #warnOnce(key, message) {
		if (this.#warned.has(key)) {
			return;
		}

		this.#warned.add(key);
		console.warn(`WFRP1ED | ${message}`);

		if (game.user?.isGM) {
			ui.notifications.warn(message);
		}
	}
}

function normalizeRole(definition) {
	const id = normalizeId(definition.id);
	const label = String(definition.label ?? id).trim();
	const labelKey = String(definition.labelKey ?? "").trim();
	const labels = normalizeLabels(definition.labels);

	if (!id || !label) {
		throw new Error("Critical table roles require id and label.");
	}

	return Object.freeze({ id, label, labelKey, labels });
}

function normalizeProvider(definition) {
	const id = normalizeId(definition.id);
	const role = normalizeId(definition.role);
	const label = String(definition.label ?? id).trim();
	const labelKey = String(definition.labelKey ?? "").trim();
	const labels = normalizeLabels(definition.labels);
	const source = String(
		definition.source ?? CRITICAL_TABLE_PROVIDER_SOURCE.MODULE,
	).trim();
	const packageId = String(definition.packageId ?? "").trim();
	const tableUuid = String(definition.tableUuid ?? "").trim();

	if (!id || !role || !label || !tableUuid) {
		throw new Error(
			"Critical table providers require id, role, label, and tableUuid.",
		);
	}

	if (!Object.values(CRITICAL_TABLE_PROVIDER_SOURCE).includes(source)) {
		throw new Error(
			`Unsupported critical table provider source '${source}'.`,
		);
	}

	if (
		source === CRITICAL_TABLE_PROVIDER_SOURCE.MODULE &&
		!packageId
	) {
		throw new Error(
			`Module critical table provider '${id}' requires packageId.`,
		);
	}

	return Object.freeze({
		id,
		role,
		label,
		labelKey,
		labels,
		source,
		packageId,
		tableUuid,
	});
}

function normalizeConfiguration(value) {
	const source = value && typeof value === "object" && !Array.isArray(value)
		? foundry.utils.deepClone(value)
		: {};
	const roles = source.roles && typeof source.roles === "object" && !Array.isArray(source.roles)
		? source.roles
		: {};
	const normalizedRoles = {};

	for (const [roleId, configuration] of Object.entries(roles)) {
		const id = normalizeId(roleId);

		if (!id) {
			continue;
		}

		normalizedRoles[id] = {
			providerId: normalizeId(configuration?.providerId),
			worldTableUuid: String(configuration?.worldTableUuid ?? "").trim(),
		};
	}

	return {
		version: CONFIG_VERSION,
		roles: normalizedRoles,
	};
}

function emptyRoleConfiguration() {
	return {
		providerId: "",
		worldTableUuid: "",
	};
}

function normalizeLabels(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return Object.freeze({});
	}

	const labels = {};

	for (const [language, label] of Object.entries(value)) {
		const lang = String(language ?? "").trim();
		const text = String(label ?? "").trim();

		if (lang && text) {
			labels[lang] = text;
		}
	}

	return Object.freeze(labels);
}

function localizedLabel(definition, fallback) {
	if (!definition) {
		return String(fallback ?? "");
	}

	if (definition.labelKey) {
		const localized = game.i18n.localize(definition.labelKey);

		if (localized !== definition.labelKey) {
			return localized;
		}
	}

	const language = String(game.i18n.lang ?? "").trim();
	return definition.labels?.[language] || definition.label;
}

function normalizeId(value) {
	return String(value ?? "").trim();
}

async function assertRollTableUuid(uuid) {
	const table = await resolveRollTable(uuid);

	if (!table) {
		throw new Error(
			`Critical table override '${uuid}' does not resolve to a RollTable.`,
		);
	}

	return table;
}

async function resolveRollTable(uuid) {
	if (!uuid) {
		return null;
	}

	try {
		const document = await foundry.utils.fromUuid(uuid);
		return document instanceof foundry.documents.RollTable
			? document
			: null;
	} catch (_error) {
		return null;
	}
}

function freezeResolution({ role, source, providerId, table }) {
	return Object.freeze({
		role,
		source,
		providerId,
		table,
		tableUuid: table.uuid,
	});
}

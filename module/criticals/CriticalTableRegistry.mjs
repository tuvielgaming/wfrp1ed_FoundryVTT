export const CRITICAL_TABLE_ROLE = Object.freeze({
	SUDDEN_DEATH: "critical.suddenDeath",
	DETAILED_CHART: "critical.detailed.chart",
	DETAILED_HEAD: "critical.detailed.head",
	DETAILED_BODY: "critical.detailed.body",
	DETAILED_ARM: "critical.detailed.arm",
	DETAILED_LEG: "critical.detailed.leg",
});

export const CRITICAL_TABLE_VARIANT = Object.freeze({
	DEFAULT: "default",
	PLUS_1: "1",
	PLUS_2: "2",
	PLUS_3: "3",
	PLUS_4: "4",
	PLUS_5: "5",
	PLUS_6_PLUS: "6+",
});

export const CRITICAL_VALUE_VARIANTS = Object.freeze([
	CRITICAL_TABLE_VARIANT.PLUS_1,
	CRITICAL_TABLE_VARIANT.PLUS_2,
	CRITICAL_TABLE_VARIANT.PLUS_3,
	CRITICAL_TABLE_VARIANT.PLUS_4,
	CRITICAL_TABLE_VARIANT.PLUS_5,
	CRITICAL_TABLE_VARIANT.PLUS_6_PLUS,
]);

export const CRITICAL_TABLE_PROVIDER_SOURCE = Object.freeze({
	CORE: "core",
	MODULE: "module",
});

const SETTINGS_NAMESPACE = "wfrp1ed";
const SETTINGS_KEY = "criticalTableConfiguration";
const CONFIG_VERSION = 2;

/**
 * Registry and world-level selection boundary for WFRP critical tables.
 *
 * A role may expose one or more stable variants. For example, the WFRP 1e
 * Sudden Death matrix is represented by six native d100 RollTables, one for
 * each critical value column (+1 through +6 or more). Providers register a
 * RollTable UUID per variant while the role remains a single stable mechanic.
 *
 * Resolution precedence is intentionally fixed for each requested variant:
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
		if (this.#settingsRegistered) return;

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

		for (const variant of Object.keys(provider.tableUuids)) {
			if (!role.variants.includes(variant)) {
				throw new Error(
					`Critical table provider '${provider.id}' supplies unknown variant '${variant}' for '${role.id}'.`,
				);
			}
		}

		if (provider.source === CRITICAL_TABLE_PROVIDER_SOURCE.CORE) {
			for (const variant of role.variants) {
				if (!provider.tableUuids[variant]) {
					throw new Error(
						`Core critical provider '${provider.id}' is missing variant '${variant}' for '${role.id}'.`,
					);
				}
			}
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
		return Object.freeze(providers ? [...providers.values()] : []);
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

		if (!provider) return false;
		if (provider.source === CRITICAL_TABLE_PROVIDER_SOURCE.CORE) return true;

		return game.modules?.get(provider.packageId)?.active === true;
	}

	static configuration() {
		this.#assertSettingsRegistered();
		return normalizeConfiguration(
			game.settings.get(SETTINGS_NAMESPACE, SETTINGS_KEY),
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

	/**
	 * Set or clear an explicit world RollTable override for one role variant.
	 * Single-variant roles may omit variantId. Multi-variant roles require it.
	 */
	static async setWorldOverride(
		roleId,
		tableUuid = "",
		variantId = "",
	) {
		this.#assertGM();
		const role = this.#assertRole(roleId);
		const variant = this.#assertVariant(role, variantId);
		const normalizedUuid = String(tableUuid ?? "").trim();

		if (normalizedUuid) await assertRollTableUuid(normalizedUuid);

		const configured = this.configuredRole(role.id);
		const worldTableUuids = {
			...(configured.worldTableUuids ?? {}),
		};

		if (normalizedUuid) worldTableUuids[variant] = normalizedUuid;
		else delete worldTableUuids[variant];

		return this.#updateRoleConfiguration(role.id, {
			worldTableUuids,
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
	 * Resolve the active RollTable for one stable critical role and variant.
	 */
	static async resolve(roleId, { variant: variantId = "" } = {}) {
		const role = this.#assertRole(roleId);
		const variant = this.#assertVariant(role, variantId);
		const configured = this.configuredRole(role.id);
		const worldTableUuid = configured.worldTableUuids?.[variant] ?? "";

		if (worldTableUuid) {
			const table = await resolveRollTable(worldTableUuid);

			if (table) {
				return freezeResolution({
					role: role.id,
					variant,
					source: "world-override",
					providerId: "",
					table,
				});
			}

			this.#warnOnce(
				`${role.id}:${variant}:world:${worldTableUuid}`,
				`Configured world critical RollTable '${worldTableUuid}' for '${role.id}' variant '${variant}' is unavailable. Falling back.`,
			);
		}

		if (configured.providerId) {
			const provider = this.provider(role.id, configured.providerId);
			const providerTableUuid = provider?.tableUuids?.[variant] ?? "";

			if (
				provider &&
				providerTableUuid &&
				this.isProviderAvailable(provider)
			) {
				const table = await resolveRollTable(providerTableUuid);

				if (table) {
					return freezeResolution({
						role: role.id,
						variant,
						source: "provider",
						providerId: provider.id,
						table,
					});
				}
			}

			this.#warnOnce(
				`${role.id}:${variant}:provider:${configured.providerId}`,
				`Configured critical provider '${configured.providerId}' for '${role.id}' variant '${variant}' is unavailable. Falling back to Core.`,
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

		const coreTableUuid = coreProvider.tableUuids[variant];

		if (!coreTableUuid) {
			throw new Error(
				`WFRP1ED Core provider '${coreProvider.id}' has no table for '${role.id}' variant '${variant}'.`,
			);
		}

		const coreTable = await resolveRollTable(coreTableUuid);

		if (!coreTable) {
			throw new Error(
				`WFRP1ED Core critical table '${coreTableUuid}' for '${role.id}' variant '${variant}' is unavailable.`,
			);
		}

		return freezeResolution({
			role: role.id,
			variant,
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
			version: CONFIG_VERSION,
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

	static #assertVariant(role, variantId = "") {
		const requested = normalizeId(variantId);
		const variant = requested || (
			role.variants.length === 1 ? role.variants[0] : ""
		);

		if (!variant || !role.variants.includes(variant)) {
			throw new Error(
				`Critical table role '${role.id}' requires one of variants: ${role.variants.join(", ")}.`,
			);
		}

		return variant;
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
		if (this.#warned.has(key)) return;

		this.#warned.add(key);
		console.warn(`WFRP1ED | ${message}`);

		if (game.user?.isGM) ui.notifications.warn(message);
	}
}

function normalizeRole(definition) {
	const id = normalizeId(definition.id);
	const label = String(definition.label ?? id).trim();
	const labelKey = String(definition.labelKey ?? "").trim();
	const labels = normalizeLabels(definition.labels);
	const variants = normalizeVariants(definition.variants);

	if (!id || !label) {
		throw new Error("Critical table roles require id and label.");
	}

	return Object.freeze({
		id,
		label,
		labelKey,
		labels,
		variants: Object.freeze(variants),
	});
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
	const tableUuids = normalizeTableUuids(definition);

	if (!id || !role || !label || Object.keys(tableUuids).length === 0) {
		throw new Error(
			"Critical table providers require id, role, label, and at least one table UUID.",
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
		tableUuids,
		// Compatibility convenience for existing single-table providers.
		tableUuid: tableUuids[CRITICAL_TABLE_VARIANT.DEFAULT] ?? "",
	});
}

function normalizeTableUuids(definition) {
	const tables = {};
	const supplied = definition?.tableUuids;

	if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
		for (const [variant, uuid] of Object.entries(supplied)) {
			const key = normalizeId(variant);
			const value = String(uuid ?? "").trim();
			if (key && value) tables[key] = value;
		}
	}

	const legacy = String(definition?.tableUuid ?? "").trim();
	if (legacy && !tables[CRITICAL_TABLE_VARIANT.DEFAULT]) {
		tables[CRITICAL_TABLE_VARIANT.DEFAULT] = legacy;
	}

	return Object.freeze(tables);
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
		if (!id) continue;

		const worldTableUuids = {};
		const supplied = configuration?.worldTableUuids;

		if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
			for (const [variant, uuid] of Object.entries(supplied)) {
				const key = normalizeId(variant);
				const value = String(uuid ?? "").trim();
				if (key && value) worldTableUuids[key] = value;
			}
		}

		// Version-1 migration for any early single-table world override.
		const legacyWorldTableUuid = String(
			configuration?.worldTableUuid ?? "",
		).trim();
		if (
			legacyWorldTableUuid &&
			!worldTableUuids[CRITICAL_TABLE_VARIANT.DEFAULT]
		) {
			worldTableUuids[CRITICAL_TABLE_VARIANT.DEFAULT] = legacyWorldTableUuid;
		}

		normalizedRoles[id] = {
			providerId: normalizeId(configuration?.providerId),
			worldTableUuids,
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
		worldTableUuids: {},
	};
}

function normalizeVariants(value) {
	const source = Array.isArray(value) && value.length > 0
		? value
		: [CRITICAL_TABLE_VARIANT.DEFAULT];
	const variants = [];

	for (const item of source) {
		const variant = normalizeId(item);
		if (variant && !variants.includes(variant)) variants.push(variant);
	}

	if (variants.length === 0) {
		variants.push(CRITICAL_TABLE_VARIANT.DEFAULT);
	}

	return variants;
}

function normalizeLabels(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return Object.freeze({});
	}

	const labels = {};

	for (const [language, label] of Object.entries(value)) {
		const lang = String(language ?? "").trim();
		const text = String(label ?? "").trim();
		if (lang && text) labels[lang] = text;
	}

	return Object.freeze(labels);
}

function localizedLabel(definition, fallback) {
	if (!definition) return String(fallback ?? "");

	if (definition.labelKey) {
		const localized = game.i18n.localize(definition.labelKey);
		if (localized !== definition.labelKey) return localized;
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
	if (!uuid) return null;

	try {
		const document = await foundry.utils.fromUuid(uuid);
		return document instanceof foundry.documents.RollTable
			? document
			: null;
	} catch (_error) {
		return null;
	}
}

function freezeResolution({ role, variant, source, providerId, table }) {
	return Object.freeze({
		role,
		variant,
		source,
		providerId,
		table,
		tableUuid: table.uuid,
	});
}

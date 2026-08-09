import { DamageApplication } from "./DamageApplication.mjs";
import {
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";
import { DamageResolver } from "./DamageResolver.mjs";

Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED damage bootstrap requires the core system API to initialize first.",
		);
	}

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		damage: Object.freeze({
			Packet: DamagePacket,
			Resolution: DamageResolution,
			Resolver: DamageResolver,
			Application: DamageApplication,
			mitigationPolicy: DAMAGE_MITIGATION_POLICY,
		}),
	});
});

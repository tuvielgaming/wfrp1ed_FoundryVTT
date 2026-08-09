import { DAMAGE_MITIGATION_POLICY, DamagePacket } from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

/** Resolve calculated tabletop-game damage without mutating an Actor. */
export class DamageResolver {
	static resolve(packet) {
		const normalized = packet instanceof DamagePacket
			? packet
			: DamagePacket.fromJSON(packet);

		if (
			normalized.mitigation.armour !== DAMAGE_MITIGATION_POLICY.IGNORE ||
			normalized.mitigation.toughness !== DAMAGE_MITIGATION_POLICY.IGNORE
		) {
			throw new Error(
				"Armour/Toughness mitigation is not implemented until the WFRP 1e combat rules are audited.",
			);
		}

		if (Object.keys(normalized.mitigation.special ?? {}).length > 0) {
			throw new Error(
				"Unregistered special mitigation flags cannot be resolved.",
			);
		}

		return DamageResolution.forPacket(normalized, {
			finalAmount: normalized.rawAmount,
			breakdown: {
				armour: { policy: DAMAGE_MITIGATION_POLICY.IGNORE, value: 0 },
				toughness: { policy: DAMAGE_MITIGATION_POLICY.IGNORE, value: 0 },
			},
		});
	}
}

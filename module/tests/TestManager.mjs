import { Test } from "./Test.mjs";

export class TestManager {
	static tests = new Map();

	static register(data) {
		const test = new Test(data);

		this.tests.set(test.id, test);
	}

	static get(id) {
		return this.tests.get(id);
	}

	static all() {
		return [...this.tests.values()];
	}
}

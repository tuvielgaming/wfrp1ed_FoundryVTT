export class SheetManager {
	static layout(sheet) {
		switch (sheet) {
			case "classic":
				return ClassicLayout;

			case "modern":
				return ModernLayout;

			default:
				return ClassicLayout;
		}
	}
}

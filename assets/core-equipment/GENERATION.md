# Core equipment image set

These 166 original inventory illustrations were created for the English and
Polish Core equipment compendiums with Codex's built-in image-generation mode.
The language packs share the same images.

No illustration was copied or extracted from a rulebook. The rulebooks were
used only to identify the catalogue entries and their rules data.

## Base prompt set

Each distinct subject from `coreEquipmentImageDefinitions()` received its own
generation call using this common specification:

```text
Use case: stylized-concept
Asset type: square game inventory icon
Primary request: <entry-specific object description>
Scene/backdrop: genuinely transparent background
Subject: exactly the requested object or matched set only, clearly readable at small size
Style/medium: gritty hand-painted low-fantasy inventory illustration, restrained ink outlines and gouache-like shading, historically grounded northern European late-medieval craftsmanship
Composition/framing: centered three-quarter view, complete object visible, generous transparent padding, strong silhouette, square icon
Lighting/mood: subdued warm studio light, worn practical object, somber late-medieval dark-fantasy atmosphere
Color palette: muted earth tones, aged leather, dark iron, restrained ochre highlights appropriate to the object
Materials/textures: tactile weathered material, hand-made construction, scuffs and use
Constraints: original design; no copied book artwork; no person; no mannequin; no text; no letters; no numbers; no symbols; no logo; no border; no watermark; no background scene; preserve actual transparency
Avoid: modern manufacture; glossy videogame loot glow; cartoon proportions; ornate high-fantasy decoration
```

The built-in service returned opaque RGB images with a rendered light
checkerboard instead of alpha transparency. Those original outputs were kept
rather than applying an unreviewed automated cutout. Mail Sleeves and Man Trap
received focused correction prompts after visual QA so their silhouettes match
the catalogue objects.

Project copies are 512 x 512 WebP images. Full-size source renders remain in
Codex's generated-image storage and are not distributed with the system.

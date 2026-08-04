export interface GalleryAnimationClip {
  index: number;
  name: string;
}

export function displayAnimationName(name: string): string {
  const localName = (name.split("|").pop() ?? name).trim();
  return localName
    .replace(/^(Animal|Character|Fish|Human|Monster|Robot|Snake)[ _-]+/iu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || name;
}

function animationOptionKey(name: string): string {
  return displayAnimationName(name).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function dedupeAnimationClips<T extends GalleryAnimationClip>(clips: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const clip of clips) {
    const key = animationOptionKey(clip.name);
    const existing = byName.get(key);
    if (!existing || (existing.name.includes("|") && !clip.name.includes("|"))) byName.set(key, clip);
  }
  return [...byName.values()];
}

function animationSearchText(name: string): string {
  return `${name} ${displayAnimationName(name)}`
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function firstSelectableAnimationClip<T extends GalleryAnimationClip>(clips: readonly T[]): T | undefined {
  const selectable = dedupeAnimationClips(clips);
  return selectable.find((clip) => /\bwalk(?:ing)?\b/u.test(animationSearchText(clip.name)))
    ?? selectable.find((clip) => !/\bidle\b/u.test(animationSearchText(clip.name)))
    ?? selectable[0];
}

export function firstSelectableAnimationValue<T extends GalleryAnimationClip>(model: { animation?: { clips: readonly T[] } }): string {
  const clip = firstSelectableAnimationClip(model.animation?.clips ?? []);
  return clip ? String(clip.index) : "";
}

export function hasAnimationValue<T extends GalleryAnimationClip>(model: { animation?: { clips: readonly T[] } }, value: string): boolean {
  if (value === "") return true;
  return dedupeAnimationClips(model.animation?.clips ?? []).some((clip) => String(clip.index) === value);
}

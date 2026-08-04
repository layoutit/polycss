const BREAKPOINT = 900;
const BOTTOM_RESERVE = 72;
const MIN_SCALE = 0.42;

export function responsiveZoomScaleForViewport(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const effectiveHeight = Math.max(1, height - BOTTOM_RESERVE);
  const widthScale = width < BREAKPOINT ? width / BREAKPOINT : 1;
  const heightScale = effectiveHeight < BREAKPOINT ? effectiveHeight / BREAKPOINT : 1;
  return Math.min(Math.max(Math.min(widthScale, heightScale), MIN_SCALE), 1);
}

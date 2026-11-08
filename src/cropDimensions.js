/**
 * Find the largest crop of the requested aspect ratio that fits in the source,
 * then zoom in without resampling. Dimensions are even for H.264 output.
 * Returns null if the ratio or zoom would leave fewer than two source pixels
 * along either axis.
 */
export function cropDimensions(sourceWidth, sourceHeight, ratioWidth = 9, ratioHeight = 16, zoom = 1) {
  const values = [sourceWidth, sourceHeight, ratioWidth, ratioHeight, zoom];
  if (values.some(value => !Number.isFinite(value) || value <= 0) || zoom < 1) return null;
  const ratio = ratioWidth / ratioHeight;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const fittedWidth = Math.min(sourceWidth, sourceHeight * ratio);
  const fittedHeight = fittedWidth / ratio;
  // The tiny tolerance prevents floating-point error from rounding 1079.9999999
  // down by two pixels when the mathematically exact result is 1080.
  const evenFloor = value => 2 * Math.floor((value + 1e-9) / 2);
  const maxW = Math.min(evenFloor(sourceWidth), evenFloor(fittedWidth / zoom));
  const maxH = Math.min(evenFloor(sourceHeight), evenFloor(fittedHeight / zoom));
  if (maxW < 2 || maxH < 2) return null;
  // Prefer an exact aspect ratio when its reduced integer terms fit at a
  // useful scale. Otherwise use the closest even-pixel crop without scaling.
  if (Number.isSafeInteger(ratioWidth) && Number.isSafeInteger(ratioHeight)) {
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = gcd(ratioWidth, ratioHeight);
    const rw = ratioWidth / divisor, rh = ratioHeight / divisor;
    const factor = Math.floor(Math.min(maxW / rw, maxH / rh) / 2) * 2;
    if (factor >= 2 && rw * factor >= maxW * 0.95 && rh * factor >= maxH * 0.95) {
      return { w: rw * factor, h: rh * factor };
    }
  }
  return { w: maxW, h: maxH };
}

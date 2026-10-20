export const qualityAnchors = Object.freeze({ high: 80, extreme: 50 });

/** E0 native baseline arguments; input is already canonical, not an arbitrary source image. */
export function nativeAvifArguments(semantic, quality, speed = 4) {
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new RangeError("AVIF quality must be an integer in 0..100");
  }
  if (speed !== 4 && speed !== 2) {
    throw new RangeError("Only the selected baseline/search efforts are admitted");
  }
  const common = ["-q", String(quality), "-s", String(speed), "-c", "aom", "-d", "10",
    "--range", "full", "--ignore-exif", "--ignore-xmp", "--ignore-icc"];
  if (semantic === "color-rgb" || semantic === "color-rgba") {
    return [...common, "-a", "tune=iq", "--yuv", "444", "--cicp", "1/13/6",
      ...(semantic === "color-rgba" ? ["--qalpha", String(quality)] : [])];
  }
  if (semantic === "normal-xy" || semantic === "data-rgb" || semantic === "moment-xyz") {
    return [...common, "-a", "tune=ssim", "--yuv", "444", "--cicp", "1/8/0"];
  }
  if (semantic === "scalar-r") {
    return [...common, "-a", "tune=ssim", "--yuv", "400", "--cicp", "1/8/6"];
  }
  throw new Error(`Unsupported native LDR AVIF semantic: ${semantic}`);
}

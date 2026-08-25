/**
 * load_environment_map：负责资源读取、解码或场景装载。
 */

import { ShadeImage, ShadeTexture } from "../texture/ShadeTexture.js";
import { Sampler2D } from "../texture/Sampler2D.js";
import { floatToHalf } from "./float16.js";
import { pathBasename } from "./pathUtils.js";
import { ProjectionMappingType } from "./ProjectionMappingType.js";
import { decodeRgbe, decodeRgbeHalf, encodeRgbe } from "./rgbe.js";
import { reprojectEquirectToOctahedral } from "./octahedralReproject.js";

export async function load_environment_map(
  url: string,
  projection: number = ProjectionMappingType.Equirectangular
): Promise<ShadeTexture> {
  const n = await fetch(url);
  const r = await n.arrayBuffer();

  let sampler: Sampler2D;

  if (projection === ProjectionMappingType.Octahedral) {
    const decoded = decodeRgbeHalf(r);
    sampler = new Sampler2D(decoded.data, 4, decoded.width, decoded.height);
  } else {
    const decoded = decodeRgbe(r);
    const source = new Sampler2D(
      decoded.data,
      4,
      decoded.width,
      decoded.height
    );
    const reprojected = reprojectEquirectToOctahedral(
      source,
      Math.min(source.width, source.height)
    );
    const fileName = pathBasename(url);
    const extension = fileName.lastIndexOf(".");
    const stem = extension !== -1 ? fileName.substring(0, extension) : fileName;
    downloadBinary(
      encodeRgbe(
        reprojected.data as Float32Array,
        reprojected.width,
        reprojected.height
      ),
      `${stem}.hdr`,
      "binary"
    );
    sampler = toHalfSampler(reprojected);
  }

  const image = ShadeImage.fromSampler2D(sampler);
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function toHalfSampler(e: Sampler2D): Sampler2D {
  const t = e.data;
  const n = Sampler2D.uint16(e.itemSize, e.width, e.height);
  const r = t.length;
  for (let i = 0; i < r; i++) {
    n.data[i] = floatToHalf(t[i]!);
  }
  return n;
}

function downloadBinary(
  e: ArrayBuffer,
  fileName: string,
  mimeType = "text/json"
): void {
  const blob = new Blob([e], { type: mimeType });
  const anchor = document.createElement("a");
  anchor.href = window.URL.createObjectURL(blob);
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

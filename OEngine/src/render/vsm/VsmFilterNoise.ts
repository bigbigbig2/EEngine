import { deserialize_shade_image } from "../../texture/deserialize_shade_image.js";
import {
  packVsmFilterData,
  VSM_FILTER_NOISE_WIDTH,
  VSM_FILTER_NOISE_HEIGHT,
  VSM_FILTER_NOISE_PHASES,
} from "../../gpu/GpuVsmFilterAbi.js";

let loaded: Promise<Uint8Array<ArrayBuffer>> | undefined;

/** CPU asset only. The lighting publication owns GPU allocation and retirement.
 * Failed fetch/validation is reported and can be retried; no random fallback. */
export function loadVsmFilterData(): Promise<Uint8Array<ArrayBuffer>> {
  if (!loaded) {
    loaded = (async () => {
      const response = await fetch(new URL("../assets/textures/stbn_vec1.bin", import.meta.url));
      if (!response.ok) {
        throw new Error(`VSM STBN load failed: HTTP ${response.status}`);
      }
      const image = deserialize_shade_image(await response.arrayBuffer());
      if (
        image.width !== VSM_FILTER_NOISE_WIDTH ||
        image.height !== VSM_FILTER_NOISE_HEIGHT ||
        image.depth !== VSM_FILTER_NOISE_PHASES ||
        image.channel_count !== 1 ||
        image.data_type !== "uint8" ||
        !(image.source instanceof ArrayBuffer)
      ) {
        throw new Error("VSM STBN asset has an unsupported scalar sequence layout");
      }
      return packVsmFilterData(new Uint8Array(image.source));
    })().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
  }
  return loaded;
}

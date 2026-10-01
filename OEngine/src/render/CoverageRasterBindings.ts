import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import type { AppearancePublishedCoverage } from "../gpu/GpuAppearancePublication.js";
import { ShadeTransparencyMode } from "../material/enums.js";

const GROUPS = new WeakMap<GraphicsContext, WeakMap<AppearancePublishedCoverage, readonly GPUBindGroup[]>>();
export function publishedRasterPrograms(runtime: GpuRenderWorldRuntime): readonly (AppearancePublishedCoverage | undefined)[] {
  const publication=runtime.appearancePublication;
  if(!publication)throw new Error("Raster requires the authoritative compiled Appearance publication");
  const masked=publication.entries.filter(entry=>entry.material.transparency_mode===ShadeTransparencyMode.AlphaTested);
  return [undefined,...new Map(masked.map(entry=>[entry.coverage.rasterProgram,entry.coverage])).values()];
}

/** Immutable source/product views and samplers are prepared once per publication
 * and shared by main and shadow raster. No sampler/view creation in warm frames. */
export function coverageRasterResourceGroups(graphics:GraphicsContext,runtime:GpuRenderWorldRuntime,
  coverage:AppearancePublishedCoverage):readonly GPUBindGroup[] {
  let cache=GROUPS.get(graphics);if(!cache){cache=new WeakMap();GROUPS.set(graphics,cache);}
  const existing=cache.get(coverage);if(existing)return existing;
  const set=runtime.materialResources.bindingSets.find(candidate=>candidate.id===coverage.textureBindingSetId)!;
  const groups=coverage.kernel.descriptor.groups.slice(1).map((entries,index)=>{
    const resources:GPUBindingResource[]=entries.map(entry=>{
      if(index===0){
        if(entry.texture)return set.textureBanks[entry.binding]!;
        const samplerIndex=entry.binding-9,address=(["clamp-to-edge","mirror-repeat","repeat"] as const)[samplerIndex%3]!,filter=samplerIndex<3?"linear":"nearest";
        return graphics.samplers.obtain({minFilter:filter,magFilter:filter,mipmapFilter:filter,addressModeU:address,addressModeV:address});
      }
      return entry.texture?coverage.productViews[entry.binding]!:graphics.samplers.obtain({minFilter:"linear",magFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"});
    });
    return graphics.bind_groups.obtain({layout:{entries},entries:resources});
  });
  cache.set(coverage,groups);return groups;
}

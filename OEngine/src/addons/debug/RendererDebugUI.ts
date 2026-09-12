import {
  Pane,
  type BindingParams,
  type FolderApi,
  type TabPageApi
} from "tweakpane";
import {
  RENDER_DEBUG_VIEW_OPTIONS,
  type RenderDebugView
} from "../../debug/RenderDebugView.js";
import type { Renderer } from "../../render/Renderer.js";
import type { RenderSettingsPatch } from "../../render/pipeline/RenderSettings.js";
import type { ResolvedRendererDebugConfig } from "./RendererDebugConfig.js";
import type { RendererInfoSnapshot } from "./RendererInfoModel.js";

type ControlValue = boolean | number | string;
type ControlState = Record<string, ControlValue>;
type ContainerApi = FolderApi | TabPageApi;
type RefreshableBinding = { refresh(): unknown };

export class RendererDebugUI {
  readonly pane: Pane;
  private readonly controls: ControlState = {};
  private readonly controlBindings: RefreshableBinding[] = [];
  private readonly infoBindings: RefreshableBinding[] = [];
  private readonly infoRows = new Map<string, Record<string, string>>();
  private readonly folders = new Map<string, readonly FolderApi[]>();
  private readonly builtInFolders: FolderApi[] = [];
  private readonly controlsPage: TabPageApi;
  private exampleFolder: FolderApi | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly config: ResolvedRendererDebugConfig,
    initialInfo: RendererInfoSnapshot
  ) {
    this.pane = new Pane({ title: "OEngine Debug" });
    const tabs = this.pane.addTab({
      pages: [{ title: "Controls" }, { title: "Renderer Info" }]
    });
    const controlsPage = tabs.pages[0];
    const infoPage = tabs.pages[1];
    if (controlsPage === undefined || infoPage === undefined) {
      throw new Error("Renderer Debug UI failed to create its tab pages");
    }
    this.controlsPage = controlsPage;
    if (config.controls) this.buildControls();
    else this.addReadonly(controlsPage, "Status", "Controls disabled");
    if (config.info) this.buildInfo(infoPage, initialInfo);
    else this.addReadonly(infoPage, "Status", "Renderer Info disabled");
  }

  refreshControls(): void {
    this.copySettings();
    for (const binding of this.controlBindings) binding.refresh();
  }

  updateInfo(snapshot: RendererInfoSnapshot): void {
    for (const section of snapshot.sections) {
      const target = this.infoRows.get(section.id);
      if (target === undefined) continue;
      for (const row of section.rows) {
        target[row.id] = decorateAvailability(row.value.display, row.value.availability);
      }
    }
    for (const binding of this.infoBindings) binding.refresh();
  }

  focus(path: string): boolean {
    const chain = this.folders.get(path);
    if (chain === undefined) return false;
    this.controlsPage.selected = true;
    for (const folder of this.builtInFolders) folder.expanded = false;
    for (const folder of chain) folder.expanded = true;
    return true;
  }

  addExampleFolder(title: string): FolderApi {
    this.controlsPage.selected = true;
    this.exampleFolder ??= this.controlsPage.addFolder({
      title: "Example",
      expanded: true
    });
    return this.exampleFolder.addFolder({ title, expanded: true });
  }

  dispose(): void {
    this.pane.dispose();
    this.controlBindings.length = 0;
    this.infoBindings.length = 0;
    this.infoRows.clear();
    this.folders.clear();
  }

  private buildControls(): void {
    this.copySettings();
    const root = this.controlsPage;
    const renderer = this.folder(root, "Renderer", "renderer");
    this.bind(
      renderer,
      "qualityProfile",
      { label: "Quality", options: { Medium: "medium", High: "high", Ultra: "ultra" } },
      () => ({ qualityProfile: String(this.controls.qualityProfile) as "medium" | "high" | "ultra" })
    );
    this.bind(renderer, "metersPerWorldUnit", { label: "Meters / unit", min: 0.001, max: 100, step: 0.001 });

    const resolution = this.folder(root, "Resolution", "resolution");
    this.bind(resolution, "resolutionMode", { label: "Mode", options: { Fixed: "fixed", Adaptive: "adaptive" } });
    this.bind(resolution, "internalScale", { label: "Internal scale", min: 0.5, max: 1, step: 0.01 });
    this.bind(resolution, "adaptiveMinimumScale", { label: "DRS minimum", min: 0.5, max: 1, step: 0.01 });
    this.bind(resolution, "adaptiveMaximumScale", { label: "DRS maximum", min: 0.5, max: 1, step: 0.01 });
    this.bind(resolution, "adaptiveTargetFrameRate", { label: "Target FPS", min: 24, max: 240, step: 1 });
    this.bind(resolution, "adaptiveTolerance", { label: "Tolerance", min: 0, max: 0.5, step: 0.01 });
    this.bind(resolution, "adaptiveSettleFrames", { label: "Settle frames", min: 1, max: 240, step: 1 });

    const materials = this.folder(root, "Materials", "materials");
    this.addReadonly(materials, "Status", "No production RenderSettings yet");
    const lighting = this.folder(root, "Lighting", "lighting");
    this.addReadonly(lighting, "Status", "Observed in Renderer Info");

    const shadows = this.folder(root, "Shadows", "shadows");
    this.bind(shadows, "shadows", { label: "Enabled" });
    this.bind(shadows, "cascadeLambda", { label: "Cascade lambda", min: 0, max: 1, step: 0.01 });
    this.bind(shadows, "maximumDistanceMeters", { label: "Max distance (m)", min: 1, max: 500, step: 1 });
    this.bind(shadows, "texelGuardBand", { label: "Texel guard", min: 0, max: 16, step: 0.25 });

    const gi = this.folder(root, "Environment & GI", "environment-gi");
    this.addReadonly(gi, "Status", "Environment controls are not in RenderSettings");

    const diffuse = this.folder(root, "Screen-Space Diffuse", "screen-space-diffuse");
    this.bind(diffuse, "screenSpaceDiffuseMode", { label: "Mode", options: { Off: "off", GTAO: "gtao", SSGI: "ssgi" } });
    const gtao = this.folder(diffuse, "GTAO", "screen-space-diffuse.gtao", [diffuse]);
    this.bind(gtao, "aoRadiusMeters", { label: "Radius (m)", min: 0.01, max: 10, step: 0.01 });
    this.bind(gtao, "aoThicknessMeters", { label: "Thickness (m)", min: 0.01, max: 10, step: 0.01 });
    this.bind(gtao, "aoIntensity", { label: "Intensity", min: 0, max: 4, step: 0.01 });
    this.bind(gtao, "aoResolutionScale", { label: "Resolution", options: { Half: 0.5, Full: 1 } });
    this.bind(gtao, "aoTemporalEnabled", { label: "Temporal" });
    this.bind(gtao, "aoSliceCount", { label: "Slices", options: { "3": 3, "5": 5 } });
    this.bind(gtao, "aoStepCount", { label: "Steps", min: 1, max: 8, step: 1 });
    this.bind(gtao, "aoSpatialStep", { label: "Spatial step", min: 1, max: 4, step: 1 });
    this.bind(gtao, "aoTemporalBlend", { label: "History blend", min: 0, max: 0.99, step: 0.01 });

    const ssgi = this.folder(diffuse, "SSGI", "screen-space-diffuse.ssgi", [diffuse]);
    this.bind(ssgi, "ssgiSamplingDomain", { label: "Domain", options: { World: "world", Screen: "screen" } });
    this.bind(ssgi, "ssgiRadiusMeters", { label: "Radius (m)", min: 0.01, max: 20, step: 0.01 });
    this.bind(ssgi, "ssgiScreenSpaceRadius", { label: "Screen radius", min: 1, max: 25, step: 1 });
    this.bind(ssgi, "ssgiThicknessMeters", { label: "Thickness (m)", min: 0.01, max: 10, step: 0.01 });
    this.bind(ssgi, "ssgiAoIntensity", { label: "AO intensity", min: 0, max: 4, step: 0.01 });
    this.bind(ssgi, "ssgiGiIntensity", { label: "GI intensity", min: 0, max: 32, step: 0.1 });
    this.bind(ssgi, "ssgiResolutionScale", { label: "Resolution", options: { Half: 0.5, Full: 1 } });
    this.bind(ssgi, "ssgiTemporalEnabled", { label: "Temporal" });
    this.bind(ssgi, "ssgiSliceCount", { label: "Slices", min: 1, max: 4, step: 1 });
    this.bind(ssgi, "ssgiStepCount", { label: "Steps", min: 1, max: 32, step: 1 });
    this.bind(ssgi, "ssgiSpatialStep", { label: "Spatial step", min: 1, max: 4, step: 1 });
    this.bind(ssgi, "ssgiTemporalBlend", { label: "History blend", min: 0, max: 0.99, step: 0.01 });
    this.bind(ssgi, "ssgiBackfaceLighting", { label: "Backface", min: 0, max: 1, step: 0.01 });

    const reflections = this.folder(root, "Reflections", "reflections");
    const ssr = this.folder(reflections, "SSR", "reflections.ssr", [reflections]);
    this.bind(ssr, "screenSpaceReflections", { label: "Enabled" });
    this.bind(ssr, "ssrResolutionScale", { label: "Resolution", options: { Half: 0.5, Full: 1 } });
    this.bind(ssr, "ssrTemporalEnabled", { label: "Temporal" });
    this.bind(ssr, "ssrMaxDistanceMeters", { label: "Max distance (m)", min: 0.1, max: 100, step: 0.1 });
    this.bind(ssr, "ssrEdgeFade", { label: "Edge fade", min: 0, max: 1, step: 0.01 });
    this.bind(ssr, "ssrMaxSteps", { label: "Max steps", min: 1, max: 256, step: 1 });
    this.bind(ssr, "ssrBaseThicknessMeters", { label: "Base thickness", min: 0.001, max: 1, step: 0.001 });
    this.bind(ssr, "ssrDistanceThicknessScale", { label: "Distance thickness", min: 0, max: 0.2, step: 0.001 });
    this.bind(ssr, "ssrMaxRoughness", { label: "Max roughness", min: 0, max: 1, step: 0.01 });
    this.bind(ssr, "ssrMirrorBias", { label: "Mirror bias", min: 0, max: 1, step: 0.01 });
    this.bind(ssr, "ssrTemporalStrength", { label: "History strength", min: 0, max: 1, step: 0.01 });

    const transparency = this.folder(root, "Transparency", "transparency");
    this.addReadonly(transparency, "Status", "No production RenderSettings yet");

    const temporal = this.folder(root, "Temporal & Reconstruction", "temporal");
    this.bind(temporal, "temporalAntiAliasing", { label: "TAA" });
    this.bind(temporal, "historyStrength", { label: "History strength", min: 0, max: 1, step: 0.01 });
    this.bind(temporal, "varianceGamma", { label: "Variance gamma", min: 0, max: 4, step: 0.01 });
    this.bind(temporal, "minimumHistoryWeight", { label: "Min history", min: 0, max: 1, step: 0.01 });
    this.bind(temporal, "maximumHistoryWeight", { label: "Max history", min: 0, max: 1, step: 0.01 });
    this.bind(temporal, "historyLockStep", { label: "Lock step", min: 0, max: 1, step: 0.001 });
    this.bind(temporal, "reactiveThreshold", { label: "Reactive threshold", min: 0, max: 1, step: 0.01 });
    this.bind(temporal, "disocclusionThreshold", { label: "Disocclusion", min: 0, max: 1, step: 0.01 });
    this.bind(temporal, "motionFadePixels", { label: "Motion fade px", min: 1, max: 512, step: 1 });

    const post = this.folder(root, "Post Processing", "post");
    this.bind(post, "motionBlur", { label: "Motion blur" });
    const bloom = this.folder(post, "Bloom", "post.bloom", [post]);
    this.bind(bloom, "bloom", { label: "Enabled" });
    this.bind(bloom, "bloomIntensity", { label: "Intensity", min: 0, max: 16, step: 0.01 });
    const exposure = this.folder(post, "Exposure", "post.exposure", [post]);
    this.bind(exposure, "automaticExposure", { label: "Automatic" });
    this.bind(exposure, "exposureCompensation", { label: "Compensation", min: 0, max: 16, step: 0.01 });
    this.bind(exposure, "exposureSpeedUp", { label: "Speed up", min: 0, max: 64, step: 0.1 });
    this.bind(exposure, "exposureSpeedDown", { label: "Speed down", min: 0, max: 64, step: 0.1 });
    const grading = this.folder(post, "Color Grading", "post.color-grading", [post]);
    this.bind(grading, "colorGradingLift", { label: "Lift", min: -1, max: 1, step: 0.01 });
    this.bind(grading, "colorGradingGamma", { label: "Gamma", min: 0.01, max: 4, step: 0.01 });
    this.bind(grading, "colorGradingGain", { label: "Gain", min: 0, max: 8, step: 0.01 });
    this.bind(grading, "colorGradingSaturation", { label: "Saturation", min: 0, max: 4, step: 0.01 });
    this.bind(grading, "colorGradingContrast", { label: "Contrast", min: 0, max: 4, step: 0.01 });
    const sharpen = this.folder(post, "Sharpening", "post.sharpening", [post]);
    this.bind(sharpen, "sharpening", { label: "Enabled" });
    this.bind(sharpen, "sharpeningStrength", { label: "Strength", min: 0, max: 1, step: 0.01 });

    const debugViews = this.folder(root, "Debug Views", "debug-views");
    const viewOptions: Record<string, string> = {};
    for (const option of RENDER_DEBUG_VIEW_OPTIONS) {
      if (option.status !== "unsupported") viewOptions[option.label] = option.view;
    }
    const viewBinding = debugViews.addBinding(this.controls, "debugView", {
      label: "View",
      options: viewOptions
    });
    viewBinding.on("change", (event) => {
      const view = String(event.value) as RenderDebugView;
      if (RENDER_DEBUG_VIEW_OPTIONS.some((entry) => entry.view === view && entry.status !== "unsupported")) {
        this.renderer.render_debug_view = view;
      }
    });
    this.controlBindings.push(viewBinding);
  }

  private buildInfo(container: ContainerApi, snapshot: RendererInfoSnapshot): void {
    for (const section of snapshot.sections) {
      const folder = container.addFolder({
        title: section.title,
        expanded: section.id === "overview"
      });
      const target: Record<string, string> = {};
      this.infoRows.set(section.id, target);
      for (const row of section.rows) {
        target[row.id] = decorateAvailability(row.value.display, row.value.availability);
        const binding = folder.addBinding(target, row.id, {
          label: row.label,
          readonly: true,
          multiline: row.id === "passes" ? true : undefined
        });
        this.infoBindings.push(binding);
      }
    }
  }

  private folder(
    parent: ContainerApi,
    title: string,
    path: string,
    ancestors: readonly FolderApi[] = []
  ): FolderApi {
    const folder = parent.addFolder({ title, expanded: this.config.expanded });
    this.builtInFolders.push(folder);
    this.folders.set(path, Object.freeze([...ancestors, folder]));
    return folder;
  }

  private bind(
    folder: FolderApi,
    key: string,
    params: BindingParams,
    patch?: () => RenderSettingsPatch
  ): void {
    const binding = folder.addBinding(this.controls, key, params);
    binding.on("change", () => this.applySettings(patch?.()));
    this.controlBindings.push(binding);
  }

  private addReadonly(folder: ContainerApi, label: string, text: string): void {
    const target = { value: text };
    folder.addBinding(target, "value", { label, readonly: true });
  }

  private copySettings(): void {
    const s = this.renderer.render_settings;
    Object.assign(this.controls, {
      qualityProfile: s.qualityProfile,
      metersPerWorldUnit: s.physicalScale.metersPerWorldUnit,
      shadows: s.features.shadows,
      screenSpaceDiffuseMode: s.features.screenSpaceDiffuseMode,
      screenSpaceReflections: s.features.screenSpaceReflections,
      temporalAntiAliasing: s.features.temporalAntiAliasing,
      bloom: s.features.bloom,
      automaticExposure: s.features.automaticExposure,
      motionBlur: s.features.motionBlur,
      sharpening: s.features.sharpening,
      resolutionMode: s.resolution.mode,
      internalScale: s.resolution.internalScale,
      adaptiveMinimumScale: s.resolution.adaptiveMinimumScale,
      adaptiveMaximumScale: s.resolution.adaptiveMaximumScale,
      adaptiveTargetFrameRate: s.resolution.adaptiveTargetFrameRate,
      adaptiveTolerance: s.resolution.adaptiveTolerance,
      adaptiveSettleFrames: s.resolution.adaptiveSettleFrames,
      cascadeLambda: s.shadows.cascadeLambda,
      maximumDistanceMeters: s.shadows.maximumDistanceMeters,
      texelGuardBand: s.shadows.texelGuardBand,
      aoRadiusMeters: s.ao.radiusMeters,
      aoThicknessMeters: s.ao.thicknessMeters,
      aoIntensity: s.ao.intensity,
      aoResolutionScale: s.ao.resolutionScale,
      aoTemporalEnabled: s.ao.temporalEnabled,
      aoSliceCount: s.ao.sliceCount,
      aoStepCount: s.ao.stepCount,
      aoSpatialStep: s.ao.spatialStep,
      aoTemporalBlend: s.ao.temporalBlend,
      ssgiSamplingDomain: s.ssgi.samplingDomain,
      ssgiRadiusMeters: s.ssgi.radiusMeters,
      ssgiScreenSpaceRadius: s.ssgi.screenSpaceRadius,
      ssgiThicknessMeters: s.ssgi.thicknessMeters,
      ssgiAoIntensity: s.ssgi.aoIntensity,
      ssgiGiIntensity: s.ssgi.giIntensity,
      ssgiResolutionScale: s.ssgi.resolutionScale,
      ssgiTemporalEnabled: s.ssgi.temporalEnabled,
      ssgiSliceCount: s.ssgi.sliceCount,
      ssgiStepCount: s.ssgi.stepCount,
      ssgiSpatialStep: s.ssgi.spatialStep,
      ssgiTemporalBlend: s.ssgi.temporalBlend,
      ssgiBackfaceLighting: s.ssgi.backfaceLighting,
      ssrResolutionScale: s.ssr.resolutionScale,
      ssrTemporalEnabled: s.ssr.temporalEnabled,
      ssrMaxDistanceMeters: s.ssr.maxDistanceMeters,
      ssrEdgeFade: s.ssr.edgeFade,
      ssrMaxSteps: s.ssr.maxSteps,
      ssrBaseThicknessMeters: s.ssr.baseThicknessMeters,
      ssrDistanceThicknessScale: s.ssr.distanceThicknessScale,
      ssrMaxRoughness: s.ssr.maxRoughness,
      ssrMirrorBias: s.ssr.mirrorBias,
      ssrTemporalStrength: s.ssr.temporalStrength,
      historyStrength: s.temporal.historyStrength,
      varianceGamma: s.temporal.varianceGamma,
      minimumHistoryWeight: s.temporal.minimumHistoryWeight,
      maximumHistoryWeight: s.temporal.maximumHistoryWeight,
      historyLockStep: s.temporal.historyLockStep,
      reactiveThreshold: s.temporal.reactiveThreshold,
      disocclusionThreshold: s.temporal.disocclusionThreshold,
      motionFadePixels: s.temporal.motionFadePixels,
      bloomIntensity: s.post.bloomIntensity,
      sharpeningStrength: s.post.sharpeningStrength,
      exposureCompensation: s.post.exposureCompensation,
      exposureSpeedUp: s.post.exposureSpeedUp,
      exposureSpeedDown: s.post.exposureSpeedDown,
      colorGradingLift: s.post.colorGradingLift,
      colorGradingGamma: s.post.colorGradingGamma,
      colorGradingGain: s.post.colorGradingGain,
      colorGradingSaturation: s.post.colorGradingSaturation,
      colorGradingContrast: s.post.colorGradingContrast,
      debugView: this.renderer.render_debug_view
    });
  }

  private applySettings(override?: RenderSettingsPatch): void {
    const c = this.controls;
    const number = (key: string): number => Number(c[key]);
    const boolean = (key: string): boolean => Boolean(c[key]);
    const patch: RenderSettingsPatch = {
      qualityProfile: String(c.qualityProfile) as "medium" | "high" | "ultra",
      physicalScale: { metersPerWorldUnit: number("metersPerWorldUnit") },
      features: {
        shadows: boolean("shadows"),
        screenSpaceDiffuseMode: String(c.screenSpaceDiffuseMode) as "off" | "gtao" | "ssgi",
        screenSpaceReflections: boolean("screenSpaceReflections"),
        temporalAntiAliasing: boolean("temporalAntiAliasing"),
        bloom: boolean("bloom"),
        automaticExposure: boolean("automaticExposure"),
        motionBlur: boolean("motionBlur"),
        sharpening: boolean("sharpening")
      },
      resolution: {
        mode: String(c.resolutionMode) as "fixed" | "adaptive",
        internalScale: number("internalScale"),
        adaptiveMinimumScale: number("adaptiveMinimumScale"),
        adaptiveMaximumScale: number("adaptiveMaximumScale"),
        adaptiveTargetFrameRate: number("adaptiveTargetFrameRate"),
        adaptiveTolerance: number("adaptiveTolerance"),
        adaptiveSettleFrames: number("adaptiveSettleFrames")
      },
      shadows: {
        cascadeLambda: number("cascadeLambda"),
        maximumDistanceMeters: number("maximumDistanceMeters"),
        texelGuardBand: number("texelGuardBand")
      },
      ao: {
        radiusMeters: number("aoRadiusMeters"), thicknessMeters: number("aoThicknessMeters"), intensity: number("aoIntensity"),
        resolutionScale: number("aoResolutionScale") as 0.5 | 1, temporalEnabled: boolean("aoTemporalEnabled"),
        sliceCount: number("aoSliceCount"), stepCount: number("aoStepCount"), spatialStep: number("aoSpatialStep"), temporalBlend: number("aoTemporalBlend")
      },
      ssgi: {
        samplingDomain: String(c.ssgiSamplingDomain) as "world" | "screen", radiusMeters: number("ssgiRadiusMeters"),
        screenSpaceRadius: number("ssgiScreenSpaceRadius"), thicknessMeters: number("ssgiThicknessMeters"), aoIntensity: number("ssgiAoIntensity"),
        giIntensity: number("ssgiGiIntensity"), resolutionScale: number("ssgiResolutionScale") as 0.5 | 1,
        temporalEnabled: boolean("ssgiTemporalEnabled"), sliceCount: number("ssgiSliceCount"), stepCount: number("ssgiStepCount"),
        spatialStep: number("ssgiSpatialStep"), temporalBlend: number("ssgiTemporalBlend"), backfaceLighting: number("ssgiBackfaceLighting")
      },
      ssr: {
        resolutionScale: number("ssrResolutionScale") as 0.5 | 1, temporalEnabled: boolean("ssrTemporalEnabled"),
        maxDistanceMeters: number("ssrMaxDistanceMeters"), edgeFade: number("ssrEdgeFade"), maxSteps: number("ssrMaxSteps"),
        baseThicknessMeters: number("ssrBaseThicknessMeters"), distanceThicknessScale: number("ssrDistanceThicknessScale"),
        maxRoughness: number("ssrMaxRoughness"), mirrorBias: number("ssrMirrorBias"), temporalStrength: number("ssrTemporalStrength")
      },
      temporal: {
        historyStrength: number("historyStrength"), varianceGamma: number("varianceGamma"), minimumHistoryWeight: number("minimumHistoryWeight"),
        maximumHistoryWeight: number("maximumHistoryWeight"), historyLockStep: number("historyLockStep"), reactiveThreshold: number("reactiveThreshold"),
        disocclusionThreshold: number("disocclusionThreshold"), motionFadePixels: number("motionFadePixels")
      },
      post: {
        bloomIntensity: number("bloomIntensity"), sharpeningStrength: number("sharpeningStrength"), exposureCompensation: number("exposureCompensation"),
        exposureSpeedUp: number("exposureSpeedUp"), exposureSpeedDown: number("exposureSpeedDown"), colorGradingLift: number("colorGradingLift"),
        colorGradingGamma: number("colorGradingGamma"), colorGradingGain: number("colorGradingGain"),
        colorGradingSaturation: number("colorGradingSaturation"), colorGradingContrast: number("colorGradingContrast")
      }
    };
    try {
      this.renderer.configure(override ?? patch);
    } catch (error) {
      console.warn("[OEngine Debug] Rejected invalid RenderSettings change.", error);
      this.refreshControls();
    }
  }
}

function decorateAvailability(display: string, availability: string): string {
  return availability === "available" ? display : `${display} · ${availability}`;
}

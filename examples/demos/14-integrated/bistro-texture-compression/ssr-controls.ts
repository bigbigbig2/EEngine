import {
  SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS,
  type Renderer,
  type ScreenSpaceReflectionsSettings,
  type RenderDebugViewName,
} from "../../../../OEngine/src/index.ts";

export interface SsrControls {
  readonly sync: () => void;
}

const SSR_DEBUG_VIEWS = new Set<RenderDebugViewName>([
  "screen-space-reflection-hit-miss",
  "screen-space-reflection-resolve",
  "screen-space-reflection-temporal",
  "screen-space-reflection-history-confidence",
]);

export function setupSsrControls(
  getRenderer: () => Renderer | undefined,
  onChange: () => void,
  onDebugViewChange?: (view: RenderDebugViewName) => void
): SsrControls {
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement;

  const viewSelect = select("sssr-debug-view");
  const note = document.getElementById("sssr-debug-note");
  const lobeSelect = select("sssr-debug-lobe");
  const strengthInput = input("sssr-strength");
  const qualitySelect = select("sssr-quality");
  const roughnessInput = input("sssr-roughness");
  const thicknessInput = input("sssr-thickness");
  const stabilityInput = input("sssr-stability");
  const resetButton = document.getElementById("sssr-reset");

  const notes: Record<string, string> = {
    none: "最终着色。SSR 反射光经降噪后按真实辐射度加权，并扣除原生被替换的 IBL 贡献。",
    "screen-space-reflection-hit-miss": "光线遍历命中与有效深度可信度（Hit Confidence 0~1）。黑色为未命中，白色为高可信命中。",
    "screen-space-reflection-resolve": "空间 Cross-Bilateral 预滤波后的反射辐射度（Prefilter Radiance）。",
    "screen-space-reflection-temporal": "时域去噪与 AABB 历史滤波合成后的最终反射辐射度（Temporal Denoised Radiance）。",
    "screen-space-reflection-history-confidence": "历史帧重投影接受度（Reprojection Acceptance）。白色为完全采信历史，黑色为失效并重新采样。",
  };

  function updateLabels() {
    const strength = Number(strengthInput.value);
    const roughness = Number(roughnessInput.value);
    const thickness = Number(thicknessInput.value);
    const stability = Number(stabilityInput.value);

    const strengthOut = document.getElementById("sssr-strength-value");
    if (strengthOut) strengthOut.textContent = strength.toFixed(2);

    const roughnessOut = document.getElementById("sssr-roughness-value");
    if (roughnessOut) roughnessOut.textContent = roughness.toFixed(2);

    const thicknessOut = document.getElementById("sssr-thickness-value");
    if (thicknessOut) thicknessOut.textContent = `${thickness.toFixed(3)} m`;

    const stabilityOut = document.getElementById("sssr-stability-value");
    if (stabilityOut) stabilityOut.textContent = stability.toFixed(2);
  }

  function sync() {
    const renderer = getRenderer();
    const settings = renderer?.screenSpaceReflectionsSettings ?? SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS;

    strengthInput.value = String(settings.strength);
    qualitySelect.value = settings.quality;
    roughnessInput.value = String(settings.maxRoughness);
    thicknessInput.value = String(settings.thicknessMeters);
    stabilityInput.value = String(settings.temporalStability);
    updateLabels();

    if (renderer) {
      lobeSelect.value = String(renderer.screenSpaceReflectionDebugLobe);
    }

    const currentView = renderer?.render_debug_view ?? "none";
    viewSelect.value = SSR_DEBUG_VIEWS.has(currentView) ? currentView : "none";
    if (note) note.textContent = notes[viewSelect.value] ?? notes.none;
  }

  function applySettings(patch: Partial<ScreenSpaceReflectionsSettings>) {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.setScreenSpaceReflectionsSettings(patch);
    renderer.invalidateTemporalHistory();
    onChange();
    sync();
  }

  for (const [elem, prop] of [
    [strengthInput, "strength"],
    [roughnessInput, "maxRoughness"],
    [thicknessInput, "thicknessMeters"],
    [stabilityInput, "temporalStability"],
  ] as const) {
    elem.addEventListener("input", updateLabels);
    elem.addEventListener("change", () => {
      applySettings({ [prop]: Number(elem.value) });
    });
  }

  qualitySelect.addEventListener("change", () => {
    applySettings({ quality: qualitySelect.value as "balanced" | "high" });
  });

  lobeSelect.addEventListener("change", () => {
    const renderer = getRenderer();
    if (renderer) {
      renderer.screenSpaceReflectionDebugLobe = Number(lobeSelect.value) as 0 | 1;
      renderer.invalidateTemporalHistory();
      onChange();
    }
  });

  viewSelect.addEventListener("change", () => {
    const targetView: RenderDebugViewName = viewSelect.value as RenderDebugViewName;
    const renderer = getRenderer();
    if (renderer) {
      renderer.render_debug_view = targetView;
      renderer.invalidateTemporalHistory();
    }
    if (note) note.textContent = notes[targetView] ?? notes.none;
    onDebugViewChange?.(targetView);
    onChange();
  });

  resetButton?.addEventListener("click", () => {
    applySettings({
      strength: SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS.strength,
      quality: SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS.quality,
      maxRoughness: SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS.maxRoughness,
      thicknessMeters: SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS.thicknessMeters,
      temporalStability: SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS.temporalStability,
    });
  });

  sync();
  return { sync };
}

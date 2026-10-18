import {
  AMBIENT_OCCLUSION_DEFAULT_SETTINGS,
  type Renderer,
  type AmbientOcclusionSettings,
  type RenderDebugViewName,
} from "../../../OEngine/src/index.ts";

export interface AoControls {
  readonly sync: () => void;
}

export function setupAoControls(
  getRenderer: () => Renderer | undefined,
  onChange: () => void,
  onDebugViewChange?: (view: RenderDebugViewName) => void
): AoControls {
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
  const viewSelect = select("ao-debug-view");
  const note = document.getElementById("ao-debug-note");
  const qualitySelect = select("ao-quality");
  const denoiseSelect = select("ao-denoise");
  const strengthInput = input("ao-strength");
  const radiusInput = input("ao-radius");
  const powerInput = input("ao-power");
  const resetButton = document.getElementById("ao-reset");

  const notes: Record<string, string> = {
    none: "最终着色画面。环境光遮蔽直接调制环境漫反射（Diffuse IBL）。",
    "ambient-occlusion": "屏幕空间可见性缓冲（Screen AO）：白色=无遮挡，黑色=深度遮蔽，独立于材质贴图 AO。",
  };

  function updateLabels() {
    const strength = Number(strengthInput.value);
    const radius = Number(radiusInput.value);
    const power = Number(powerInput.value);

    const strengthOut = document.getElementById("ao-strength-value");
    if (strengthOut) strengthOut.textContent = strength.toFixed(2);

    const radiusOut = document.getElementById("ao-radius-value");
    if (radiusOut) radiusOut.textContent = `${radius.toFixed(1)} m`;

    const powerOut = document.getElementById("ao-power-value");
    if (powerOut) powerOut.textContent = power.toFixed(1);
  }

  function sync() {
    const renderer = getRenderer();
    const settings = renderer?.ambientOcclusionSettings ?? AMBIENT_OCCLUSION_DEFAULT_SETTINGS;

    strengthInput.value = String(settings.strength);
    radiusInput.value = String(settings.radiusMeters);
    powerInput.value = String(settings.finalValuePower);
    qualitySelect.value = settings.quality;
    denoiseSelect.value = String(settings.denoisePasses);
    updateLabels();

    const currentView = renderer?.render_debug_view ?? "none";
    viewSelect.value = currentView === "ambient-occlusion" ? "ambient-occlusion" : "none";
    if (note) note.textContent = notes[viewSelect.value] ?? notes.none;
  }

  function applySettings(patch: Partial<AmbientOcclusionSettings>) {
    const renderer = getRenderer();
    if (!renderer) return;
    renderer.setAmbientOcclusionSettings(patch);
    renderer.invalidateTemporalHistory();
    onChange();
    sync();
  }

  for (const [elem, prop] of [
    [strengthInput, "strength"],
    [radiusInput, "radiusMeters"],
    [powerInput, "finalValuePower"],
  ] as const) {
    elem.addEventListener("input", updateLabels);
    elem.addEventListener("change", () => {
      applySettings({ [prop]: Number(elem.value) });
    });
  }

  qualitySelect.addEventListener("change", () => {
    applySettings({ quality: qualitySelect.value as "medium" | "high" });
  });

  denoiseSelect.addEventListener("change", () => {
    applySettings({ denoisePasses: Number(denoiseSelect.value) as 0 | 1 | 2 | 3 });
  });

  viewSelect.addEventListener("change", () => {
    const targetView: RenderDebugViewName = viewSelect.value === "ambient-occlusion" ? "ambient-occlusion" : "none";
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
    applySettings(AMBIENT_OCCLUSION_DEFAULT_SETTINGS);
  });

  sync();
  return { sync };
}

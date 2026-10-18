import {
  VSM_DEFAULT_SETTINGS,
  type Renderer,
  type VsmSettings,
  type VsmFilterMode,
  type VsmDebugView
} from "../../../OEngine/src/index.ts";

const controls = [
  ["vsm-radius", "filterRadiusTexels"],
  ["vsm-depth-bias", "depthBiasTexels"],
  ["vsm-angular-bias", "angularBiasTexels"],
  ["vsm-coverage", "clipExtentScale"]
] as const;

export function setupVsmControls(getRenderer: () => Renderer | undefined, onChange: () => void) {
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const filter = document.getElementById("vsm-filter") as HTMLSelectElement;
  const view = document.getElementById("vsm-debug-view") as HTMLSelectElement;
  const note = document.getElementById("vsm-debug-note")!;
  const notes: Record<VsmDebugView, string> = {
    none: "正常画面。参数在松开滑块后应用；调试视图关闭时不执行额外采样。",
    visibility: "白=受光，黑=遮挡，紫=无有效页，青=无 caster / 不接收阴影。",
    "clip-level": "实际采样层级：0 红、1 橙、2 黄、3 绿、4 蓝、5 紫。失效页为亮紫；颜色经过显示映射。",
    "page-state":
      "绿 Fine · 蓝 Coarse · 紫 Missing · 红 Stale · 黄 Dirty · 灰 Outside · 青 无 caster / 不接收阴影。"
  };
  function label(id: string) {
    const value = Number(input(id).value);
    document.getElementById(`${id}-value`)!.textContent =
      `${value.toFixed(2)}${id === "vsm-coverage" ? " ×" : ""}`;
  }
  function sync() {
    const renderer = getRenderer();
    const settings = renderer?.vsmSettings ?? VSM_DEFAULT_SETTINGS;
    for (const [id, key] of controls) {
      input(id).value = String(settings[key]);
      label(id);
    }
    filter.value = settings.filterMode;
    input("vsm-radius").disabled = settings.filterMode !== "disk4";
    if (settings.filterMode !== "disk4") {
      document.getElementById("vsm-radius-value")!.textContent =
        settings.filterMode === "gather2x2" ? "Fixed 2×2" : "Single texel";
    }
    view.value = settings.debugView;
    note.textContent = notes[settings.debugView];
  }
  for (const [id, key] of controls) {
    input(id).addEventListener("input", () => label(id));
    input(id).addEventListener("change", () => {
      const renderer = getRenderer();
      if (!renderer) return;
      const patch: Partial<VsmSettings> = { [key]: Number(input(id).value) };
      renderer.setVsmSettings(patch);
      onChange();
      sync();
    });
  }
  filter.addEventListener("change", () => {
    getRenderer()?.setVsmSettings({ filterMode: filter.value as VsmFilterMode });
    onChange();
    sync();
  });
  view.addEventListener("change", () => {
    getRenderer()?.setVsmSettings({ debugView: view.value as VsmDebugView });
    onChange();
    sync();
  });
  document.getElementById("vsm-rebuild")!.addEventListener("click", () => {
    getRenderer()?.invalidateVsmPages();
    onChange();
  });
  document.getElementById("vsm-reset")!.addEventListener("click", () => {
    getRenderer()?.setVsmSettings(VSM_DEFAULT_SETTINGS);
    onChange();
    sync();
  });
  sync();
  return { sync };
}

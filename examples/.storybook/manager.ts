import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

addons.setConfig({
  showPanel: false,
  theme: create({
    base: "light",
    brandTitle: "OEngine Examples",
    brandTarget: "_self",
    colorPrimary: "#2563eb",
    colorSecondary: "#2563eb",
    appBg: "#f4f7fb",
    appContentBg: "#ffffff",
    appPreviewBg: "#ffffff",
    appBorderColor: "#dfe5ee",
    barBg: "#ffffff",
    barTextColor: "#64748b",
    barSelectedColor: "#2563eb",
    inputBg: "#ffffff",
    inputBorder: "#cbd5e1",
    inputTextColor: "#0f172a",
    textColor: "#0f172a",
    textMutedColor: "#64748b"
  })
});

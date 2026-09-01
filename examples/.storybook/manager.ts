import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

addons.setConfig({
  theme: create({
    base: "dark",
    brandTitle: "OEngine Examples",
    brandTarget: "_self",
    colorPrimary: "#66a6ff",
    colorSecondary: "#66a6ff",
    appBg: "#0c0f14",
    appContentBg: "#12161d",
    appPreviewBg: "#0c0f14",
    appBorderColor: "#2a323e",
    barBg: "#12161d",
    barTextColor: "#929dad",
    barSelectedColor: "#66a6ff",
    inputBg: "#181d26",
    inputBorder: "#2a323e",
    inputTextColor: "#e7ebf2",
    textColor: "#e7ebf2",
    textMutedColor: "#929dad"
  })
});

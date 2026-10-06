import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../../../packages/variables/src/**/*.stories.@(ts|tsx)"],
  core: { disableTelemetry: true },
  viteFinal: (vite) =>
    mergeConfig(vite, {
      plugins: [tailwindcss()],
      resolve: { dedupe: ["react", "react-dom"] },
    }),
};

export default config;

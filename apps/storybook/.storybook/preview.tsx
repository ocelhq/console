import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import "./storybook.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "light or dark tokens",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", icon: "sun", title: "Light" },
          { value: "dark", icon: "moon", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    layout: "padded",
    backgrounds: { disable: true },
  },
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === "dark";
      useEffect(() => {
        const root = document.documentElement;
        root.dataset.register = "operate";
        root.classList.toggle("dark", dark);
        root.style.colorScheme = dark ? "dark" : "light";
      }, [dark]);
      return <Story />;
    },
  ],
};

export default preview;

import type { Meta, StoryObj } from "@storybook/react-vite";
import { populated, production, values } from "../stories/fixtures";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/CopyPanel",
  component: Surface,
  args: { state: populated, port: { values, other: production } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FromProduction: Story = {
  args: { setup: (live) => void live.openCopy() },
};

export const Overwriting: Story = {
  args: {
    setup: (live) =>
      void live.openCopy().then(() => {
        live.toggleOverwriting();
      }),
  },
};

export const Unreadable: Story = {
  args: {
    port: { values, other: { tier: "production", values: [] } },
    setup: (live) => void live.openCopy(),
  },
};

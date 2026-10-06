import type { Meta, StoryObj } from "@storybook/react-vite";
import { coordinateKey } from "../model";
import { populated, values } from "../stories/fixtures";
import { at } from "../stories/memory-port";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/BulkBar",
  component: Surface,
  args: { state: populated, port: { values } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Selected: Story = {
  args: {
    setup: (live) => {
      live.selected.value = new Set(
        [at("DATABASE_URL"), at("LOG_LEVEL"), at("STRIPE_SECRET_KEY", "/api")].map(coordinateKey),
      );
    },
  },
};

export const EverythingVisible: Story = {
  args: { setup: (live) => live.selectVisible(true) },
};

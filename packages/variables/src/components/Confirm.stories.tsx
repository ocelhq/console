import type { Meta, StoryObj } from "@storybook/react-vite";
import { populated, values } from "../stories/fixtures";
import { at } from "../stories/memory-port";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/Confirm",
  component: Surface,
  args: { state: populated, port: { values } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RemoveOne: Story = {
  args: { setup: (live) => live.askRemoval([at("LOG_LEVEL")]) },
};

export const RemoveSeveral: Story = {
  args: {
    setup: (live) =>
      live.askRemoval([
        at("LOG_LEVEL"),
        at("SENTRY_DSN", "/web"),
        at("STRIPE_WEBHOOK_SECRET", "/api"),
      ]),
  },
};

export const Removing: Story = {
  args: {
    setup: (live) => {
      live.askRemoval([at("LOG_LEVEL")]);
      live.saving.value = true;
    },
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { coordinateKey } from "../model";
import { faulty, history, populated, values } from "../stories/fixtures";
import { at } from "../stories/memory-port";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/Drawer",
  component: Surface,
  args: { state: populated, port: { values, history } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithHistory: Story = {
  args: { setup: (live) => live.openDrawer(at("DATABASE_URL")) },
};

export const Loading: Story = {
  args: {
    port: { values, history, latency: 60_000 },
    setup: (live) => live.openDrawer(at("SESSION_SECRET")),
  },
};

export const HistoryUnreadable: Story = {
  args: {
    port: { values, historyError: "the history service did not answer" },
    setup: (live) => live.openDrawer(at("STRIPE_SECRET_KEY", "/api")),
  },
};

export const SchemaFault: Story = {
  args: {
    state: faulty,
    setup: (live) => live.openDrawer(at("NEXT_PUBLIC_SITE_URL", "/web")),
  },
};

export const Conflict: Story = {
  args: {
    setup: (live) => {
      live.problems.value = new Map([
        [
          coordinateKey(at("LOG_LEVEL")),
          { kind: "conflict", message: "someone saved version 2 first" },
        ],
      ]);
      live.openDrawer(at("LOG_LEVEL"));
    },
  },
};

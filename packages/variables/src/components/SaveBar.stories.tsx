import type { Meta, StoryObj } from "@storybook/react-vite";
import { populated, values } from "../stories/fixtures";
import { at } from "../stories/memory-port";
import { type Live, Surface } from "../stories/Surface";

const meta = {
  title: "Variables/SaveBar",
  component: Surface,
  args: { state: populated, port: { values } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

const edit = (live: Live) => {
  live.setDraft(at("LOG_LEVEL"), "debug");
  live.setDraft(at("NEXT_PUBLIC_SITE_URL", "/web"), "https://pr-12.acme.dev");
};

export const Pending: Story = {
  args: { setup: edit },
};

export const Saving: Story = {
  args: {
    setup: (live) => {
      edit(live);
      live.saving.value = true;
    },
  },
};

export const Saved: Story = {
  args: {
    setup: (live) => {
      live.outcome.value = { text: "Saved 2 values." };
    },
  },
};

export const Failed: Story = {
  args: {
    setup: (live) => {
      edit(live);
      live.outcome.value = {
        text: "Saved 1 of 2 values; 1 changed here underneath you — see the marked rows.",
        tone: "error",
      };
    },
  },
};

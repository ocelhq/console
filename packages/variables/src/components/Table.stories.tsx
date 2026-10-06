import type { Meta, StoryObj } from "@storybook/react-vite";
import { coordinateKey } from "../model";
import {
  empty,
  envSourced,
  faulty,
  populated,
  readOnly,
  unfilled,
  values,
} from "../stories/fixtures";
import { at } from "../stories/memory-port";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/Table",
  component: Surface,
  args: { state: populated, port: { values } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { state: empty },
};

export const NoMatch: Story = {
  args: { setup: (live) => live.setSearch("AWS_") },
};

export const Revealed: Story = {
  args: {
    setup: (live) =>
      void live.reveal([
        at("DATABASE_URL"),
        at("SESSION_SECRET"),
        at("LOG_LEVEL"),
        at("SENTRY_DSN", "/web"),
        at("SENTRY_DSN", "/api"),
        at("NEXT_PUBLIC_SITE_URL", "/web"),
        at("STRIPE_SECRET_KEY", "/api"),
        at("STRIPE_WEBHOOK_SECRET", "/api"),
      ]),
  },
};

export const NamedEnvironment: Story = {
  args: { setup: (live) => live.pickEnvironment("pr-12") },
};

export const Unfilled: Story = {
  args: {
    state: unfilled,
    setup: (live) => {
      live.unfilledOnly.value = true;
    },
  },
};

export const WithErrors: Story = {
  args: {
    state: faulty,
    port: {
      values,
      unreadable: {
        [coordinateKey(at("STRIPE_SECRET_KEY", "/api"))]: "the key store refused to decrypt it",
      },
    },
    setup: (live) => {
      void live.reveal([at("STRIPE_SECRET_KEY", "/api"), at("LOG_LEVEL")]);
      live.setDraft(at("LOG_LEVEL"), "debug");
      live.problems.value = new Map([
        [
          coordinateKey(at("LOG_LEVEL")),
          { kind: "conflict", message: "someone saved version 2 first" },
        ],
        [
          coordinateKey(at("SENTRY_DSN", "/web")),
          { kind: "error", message: "the write timed out" },
        ],
      ]);
    },
  },
};

export const EnvSource: Story = {
  args: { state: envSourced },
};

export const OptionalGroupOn: Story = {
  args: { setup: (live) => live.switchVariableGroup("github", true) },
};

export const ReadOnly: Story = {
  args: { state: readOnly, readOnly: true },
};

export const Dropping: Story = {
  args: {
    setup: (live) => {
      live.dragTarget.value = "/web";
    },
  },
};

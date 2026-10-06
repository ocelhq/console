import type { Meta, StoryObj } from "@storybook/react-vite";
import { populated, values } from "../stories/fixtures";
import { Surface } from "../stories/Surface";

const meta = {
  title: "Variables/DropNotice",
  component: Surface,
  args: { state: populated, port: { values } },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

const dotenv = [
  "LOG_LEVEL=debug",
  "SENTRY_DSN=https://4f1e@o12.ingest.sentry.io/999",
  "NEXT_PUBLIC_SITE_URL=https://pr-12.acme.dev",
  "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  "OPENAI_API_KEY=sk-proj-example",
].join("\n");

export const Imported: Story = {
  args: { setup: (live) => live.applyDrop(".env.local", dotenv, "/web") },
};

export const NothingToFill: Story = {
  args: { setup: (live) => live.applyDrop(".env", "UNKNOWN_KEY=1", "") },
};

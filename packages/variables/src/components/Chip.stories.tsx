import type { Meta, StoryObj } from "@storybook/react-vite";
import { Chip, ChipButton, Note, SectionLabel, type Tone } from "./Chip";
import { Fault } from "./Fault";

const tones: Tone[] = ["default", "muted", "warn", "bad", "accent", "soon", "ink"];

const meta = {
  title: "Variables/Primitives",
  component: Chip,
} satisfies Meta<typeof Chip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Chips: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {tones.map((tone) => (
        <Chip tone={tone} key={tone}>
          {tone}
        </Chip>
      ))}
      <ChipButton tone="default">clickable</ChipButton>
    </div>
  ),
};

export const Notes: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-4">
      <SectionLabel>History</SectionLabel>
      <Note label="Imported">
        <p>3 rows filled in /web, unsaved until you save.</p>
      </Note>
      <Fault>The value here fails its schema: expected a URL</Fault>
    </div>
  ),
};

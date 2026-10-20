import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EdgeMark, ProviderMark } from "./marks";

const cutRing = "M66.94 2.96";

describe("ProviderMark", () => {
  it("draws the Ocel mark for Ocel Cloud", () => {
    expect(renderToStaticMarkup(<ProviderMark provider="ocel" />)).toContain(cutRing);
  });

  it("draws the Ocel mark for an Ocel Cloud resource too", () => {
    expect(
      renderToStaticMarkup(<ProviderMark provider="ocel" resourceType="postgres" />),
    ).toContain(cutRing);
  });

  it("draws no Ocel mark for another provider", () => {
    expect(renderToStaticMarkup(<ProviderMark provider="vps" />)).not.toContain(cutRing);
  });
});

describe("EdgeMark", () => {
  it("draws the Ocel mark for Ocel Cloud's edge", () => {
    expect(renderToStaticMarkup(<EdgeMark edge="ocel-cloud" />)).toContain(cutRing);
    expect(renderToStaticMarkup(<EdgeMark edge="cloudfront" />)).not.toContain(cutRing);
  });
});

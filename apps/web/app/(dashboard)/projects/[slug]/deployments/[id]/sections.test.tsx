import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Domains } from "./sections";

describe("Domains with no hostnames", () => {
  it("offers no `ocel domain add` on Ocel Cloud, which doesn't run it", () => {
    const html = renderToStaticMarkup(<Domains apps={[]} own={false} />);
    expect(html).toContain("Ocel Cloud assigned");
    expect(html).not.toContain("ocel domain add");
  });

  it("offers `ocel domain add` for a provider of your own", () => {
    const html = renderToStaticMarkup(<Domains apps={[]} own />);
    expect(html).toContain("ocel domain add");
  });
});

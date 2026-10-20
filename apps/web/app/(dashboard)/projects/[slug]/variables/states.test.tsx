import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Provenance } from "./provenance";
import { NoConnector, Refused } from "./states";

describe("NoConnector", () => {
  it("says the values live in Ocel Cloud and points at a command that runs there", () => {
    const html = renderToStaticMarkup(<NoConnector vendor="ocel" />);
    expect(html).toContain("Values live in Ocel Cloud");
    expect(html).toContain("ocel env ls");
    expect(html).not.toContain("ocel connector add");
  });

  it("sends anyone else to add a connector in their own account", () => {
    const html = renderToStaticMarkup(<NoConnector vendor="aws" />);
    expect(html).toContain("your aws account");
    expect(html).toContain("ocel connector add");
  });
});

describe("Refused", () => {
  it("offers no connector command on Ocel Cloud, where none runs", () => {
    const html = renderToStaticMarkup(
      <Refused reason="offline" message="no answer" provider="ocel" />,
    );
    expect(html).not.toContain("ocel connector");
  });

  it("offers the connector command for a target of your own", () => {
    const html = renderToStaticMarkup(
      <Refused reason="offline" message="no answer" provider="aws" />,
    );
    expect(html).toContain("ocel connector status");
  });
});

describe("Provenance", () => {
  it("names the provider Ocel Cloud and the values live from it", () => {
    const html = renderToStaticMarkup(
      <Provenance
        deployedAt="2026-10-20T10:00:00.000Z"
        now="2026-10-20T10:05:00.000Z"
        promotion={null}
        provider="ocel"
        region={null}
        live
      />,
    );
    expect(html).toContain("Ocel Cloud");
    expect(html).toContain("live from Ocel Cloud");
    expect(html).not.toContain(">ocel<");
  });
});

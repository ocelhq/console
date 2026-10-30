import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthPanel } from "./auth-panel";

describe("AuthPanel", () => {
  it("draws the aside beside the panel", () => {
    const html = renderToStaticMarkup(
      <AuthPanel title="Sign in" description="Continue." aside={<p>inside</p>}>
        <p>form</p>
      </AuthPanel>,
    );
    expect(html).toContain("<aside");
    expect(html).toContain("inside");
  });

  it("draws no aside without one", () => {
    const html = renderToStaticMarkup(<AuthPanel title="Sign in" description="Continue." />);
    expect(html).not.toContain("<aside");
  });
});

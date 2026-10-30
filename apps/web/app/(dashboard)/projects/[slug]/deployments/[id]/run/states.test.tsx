import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobSignedOut } from "./states";

describe("JobSignedOut", () => {
  it("sends the reader to sign in and back to this job, in its organization", () => {
    const html = renderToStaticMarkup(<JobSignedOut href="/projects/web/deployments/dep-1" />);
    expect(html).toContain('href="/sign-in?redirect=%2Fprojects%2Fweb%2Fdeployments%2Fdep-1"');
    expect(html).toContain("signed out");
    expect(html).not.toContain("Lost touch");
  });
});

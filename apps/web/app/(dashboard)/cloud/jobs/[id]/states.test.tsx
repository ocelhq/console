import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobSignedOut } from "./states";

describe("JobSignedOut", () => {
  it("sends the reader to sign in and back to this job, in its organization", () => {
    const html = renderToStaticMarkup(<JobSignedOut href="/cloud/jobs/job_1?org=org-1" />);
    expect(html).toContain('href="/sign-in?redirect=%2Fcloud%2Fjobs%2Fjob_1%3Forg%3Dorg-1"');
    expect(html).toContain("signed out");
    expect(html).not.toContain("Lost touch");
  });
});

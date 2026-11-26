import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApproveDevice } from "./approve-device";

describe("ApproveDevice", () => {
  it("names the account the device will sign in to", () => {
    const html = renderToStaticMarkup(
      <ApproveDevice userCode="ABCD1234" signedInAs="ada@example.com" />,
    );
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Switch account");
  });

  it("asks for a fresh login when there is no code", () => {
    const html = renderToStaticMarkup(<ApproveDevice userCode="" signedInAs="ada@example.com" />);
    expect(html).toContain("Missing code");
    expect(html).not.toContain("Approve");
  });
});

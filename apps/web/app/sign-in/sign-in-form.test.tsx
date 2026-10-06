import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignInForm } from "./sign-in-form";

function render(methods: { github: boolean; email: boolean }) {
  return renderToStaticMarkup(<SignInForm {...methods} callbackURL="/" />);
}

describe("SignInForm", () => {
  it("offers only GitHub when email sign-in is off", () => {
    const html = render({ github: true, email: false });
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain('type="password"');
  });

  it("offers only email and password when GitHub is off", () => {
    const html = render({ github: false, email: true });
    expect(html).not.toContain("Sign in with GitHub");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
  });

  it("offers both when both are on", () => {
    const html = render({ github: true, email: true });
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('type="password"');
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpokenCaption } from "./SpokenCaption";

// Structure checks only. These do not substitute for a rendered motion review.
describe("spoken caption markup", () => {
  it("renders the current small fragment without the preceding conversation", () => {
    const markup = renderToStaticMarkup(<SpokenCaption text="I'm so sorry that happened. That really sucks. How are you feeling?" visible speaking />);
    expect(markup).toContain('data-caption-words="4"');
    expect(markup).toContain("feeling?");
    expect(markup).not.toContain("sorry");
    expect(markup).not.toContain("sucks");
    expect(markup).not.toContain("scroll");
  });

  it("keeps a hidden caption outside the accessibility tree without clearing its words", () => {
    const markup = renderToStaticMarkup(<SpokenCaption text="A lovely little moment." visible={false} speaking={false} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("moment.");
    expect(markup).not.toContain("caption-line--speaking");
  });

  it("does not announce each streaming word as a separate screen-reader message", () => {
    const markup = renderToStaticMarkup(<SpokenCaption text="Hello there." visible speaking />);
    expect(markup).toContain('aria-live="off"');
    expect(markup).toContain('aria-label="Spoken caption"');
  });
});

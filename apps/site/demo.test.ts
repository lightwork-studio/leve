import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";

it("loads the hero phone on demand and discards the app when the demo closes", async () => {
  const window = new Window({
    url: "https://leve.example/",
    settings: { disableIframePageLoading: true },
  });
  Object.defineProperty(window, "isSecureContext", { value: true });
  try {
    const { document } = window;
    document.write(await readFile(new URL("./index.html", import.meta.url), "utf8"));
    const open = document.querySelector<HTMLButtonElement>("#demo-open");
    const close = document.querySelector<HTMLButtonElement>("#demo-close");
    const tools = document.querySelector<HTMLElement>("#demo-tools");
    const demo = document.querySelector<HTMLElement>("#hero-demo");
    const screenshot = document.querySelector<HTMLImageElement>("#hero-screenshot");
    assert(open && close && tools && demo && screenshot);
    expect(demo.parentElement).toBe(screenshot.parentElement);
    const frame = () => demo.querySelector("iframe");
    const scrollIntoView = vi.spyOn(tools, "scrollIntoView");
    const openFocus = vi.spyOn(open, "focus");
    const screenRect = vi.spyOn(demo, "getBoundingClientRect");
    const closeRect = vi.spyOn(close, "getBoundingClientRect");
    closeRect.mockReturnValue(new window.DOMRect(0, 50, 110, 40));
    // The phone is visible, even though its bottom extends below the fold.
    screenRect.mockReturnValue(new window.DOMRect(0, 100, 312, window.innerHeight));
    expect(open.hidden).toBe(true);
    expect(frame()).toBeNull();

    const script = await readFile(new URL("./demo.js", import.meta.url), "utf8");
    runInNewContext(script, { window, document });
    expect(open.hidden).toBe(false);
    expect(frame()).toBeNull();
    expect(screenshot.hidden).toBe(false);

    open.click();
    const first = frame();
    expect(first?.getAttribute("src")).toBe("./demo/");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screenshot.hidden).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(scrollIntoView).not.toHaveBeenCalled();

    open.click();
    expect(frame()).toBe(first);
    close.click();
    expect(frame()).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(screenshot.hidden).toBe(false);
    expect(document.activeElement).toBe(open);
    expect(openFocus).toHaveBeenLastCalledWith({ preventScroll: false });

    // If the phone is already visible and Close is above the fold, keep focus on the opener.
    closeRect.mockReturnValue(new window.DOMRect(0, -50, 110, 40));
    open.click();
    expect(document.activeElement).toBe(open);
    expect(scrollIntoView).not.toHaveBeenCalled();
    close.dispatchEvent(new window.MouseEvent("click", { detail: 1 }));
    expect(openFocus).toHaveBeenLastCalledWith({ preventScroll: true });

    // On a stacked hero, clicking the CTA can place the whole phone below the fold.
    closeRect.mockReturnValue(new window.DOMRect(0, 50, 110, 40));
    screenRect.mockReturnValue(new window.DOMRect(0, window.innerHeight + 20, 312, 676));
    open.click();
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(first);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(close);
  } finally {
    await window.happyDOM.close();
  }
});

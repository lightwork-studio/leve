import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { expect, it } from "vitest";

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
    const screenshot = document.querySelector<HTMLImageElement>("#hero-screenshot");
    assert(open && close && screenshot);
    const frame = () => document.querySelector("#hero-demo iframe");
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

    open.click();
    expect(frame()).toBe(first);
    close.click();
    expect(frame()).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(screenshot.hidden).toBe(false);
    expect(document.activeElement).toBe(open);

    open.click();
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(first);
  } finally {
    await window.happyDOM.close();
  }
});

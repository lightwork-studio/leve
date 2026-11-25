// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { revealInList } from "../src/ui/reveal.ts";

/** Lays an element out at `top` (relative to the window) with `height`, as a browser would. */
function place(element: Element, top: number, height: number) {
  const box = new DOMRect(0, top, 300, height);
  element.getBoundingClientRect = () => box;
  element.getClientRects = () => [box] as unknown as DOMRectList;
}

function size(element: HTMLElement, clientHeight: number, scrollHeight: number) {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
}

/** A scrolling list 600 tall whose top is 100 down the page, inside a page that also scrolls. */
function setUp() {
  const page = document.createElement("main");
  page.style.overflowY = "auto";
  size(page, 800, 3000);
  place(page, 0, 800);
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  size(list, 600, 2000);
  place(list, 100, 600);
  const row = document.createElement("div");
  const target = document.createElement("span");
  row.append(target);
  list.append(row);
  page.append(list);
  document.body.append(page);
  return { page, list, target };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("brings the element to the top of its list without scrolling the page around it", () => {
  const { page, list, target } = setUp();
  place(target, 900, 40);
  revealInList(target, "start");
  expect(list.scrollTop).toBe(800);
  expect(page.scrollTop).toBe(0);
});

it("moves the list only as far as it takes to show the element", () => {
  const { page, list, target } = setUp();
  place(target, 680, 40);
  revealInList(target, "nearest");
  expect(list.scrollTop).toBe(20);

  place(target, 85, 40);
  revealInList(target, "nearest");
  expect(list.scrollTop).toBe(5);
  expect(page.scrollTop).toBe(0);
});

it("leaves the list alone when the element already shows", () => {
  const { list, target } = setUp();
  list.scrollTop = 50;
  place(target, 300, 40);
  revealInList(target, "nearest");
  expect(list.scrollTop).toBe(50);
});

it("shows the top of an element taller than its list", () => {
  const { list, target } = setUp();
  place(target, 400, 900);
  revealInList(target, "nearest");
  expect(list.scrollTop).toBe(300);
});

it("skips an ancestor that hides its overflow or has nothing to scroll", () => {
  const { page, list, target } = setUp();
  list.style.overflowY = "hidden";
  place(target, 1000, 40);
  revealInList(target, "start");
  expect(list.scrollTop).toBe(0);
  expect(page.scrollTop).toBe(1000);
});

it("skips an ancestor whose content all fits", () => {
  const { page, list, target } = setUp();
  size(list, 600, 600);
  place(target, 1000, 40);
  revealInList(target, "start");
  expect(list.scrollTop).toBe(0);
  expect(page.scrollTop).toBe(1000);
});

it("leaves everything alone for an element that isn't shown", () => {
  const { page, list, target } = setUp();
  list.scrollTop = 50;
  place(target, 0, 0);
  target.getClientRects = () => [] as unknown as DOMRectList;
  revealInList(target, "nearest");
  expect(list.scrollTop).toBe(50);
  expect(page.scrollTop).toBe(0);
});

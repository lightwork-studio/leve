/**
 * Scrolls the list an element sits in so the element shows, like the browser's scrollIntoView but
 * moving only that list. scrollIntoView also scrolls every page around the app, so on a page that
 * shows the app in a frame (the web demo) each jump would scroll that page too. Browsers only.
 *
 * `start` puts the element's top at the list's top. `nearest` moves the list only as far as it
 * takes to show the element, and not at all when it already shows.
 */
export function revealInList(element: HTMLElement, block: "start" | "nearest") {
  const list = scrollingAncestor(element);
  if (!list) return;
  const box = element.getBoundingClientRect();
  const top = box.top - viewportTop(list);
  const bottom = top + box.height;
  const height = list.clientHeight;
  let by = 0;
  if (block === "start" || top < 0) by = top;
  // A taller element than the list shows its top.
  else if (bottom > height) by = Math.min(top, bottom - height);
  if (by !== 0) list.scrollTop += by;
}

/** The top of what the list shows, inside its border. */
function viewportTop(list: Element) {
  const document = list.ownerDocument;
  if (list === document.scrollingElement) return 0;
  return list.getBoundingClientRect().top + list.clientTop;
}

/** The nearest ancestor that scrolls up and down, or the frame's own page when none does. */
function scrollingAncestor(element: HTMLElement): Element | null {
  const view = element.ownerDocument.defaultView;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = view?.getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return element.ownerDocument.scrollingElement;
}

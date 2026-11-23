import { AccessibilityInfo, type HostInstance, Platform } from "react-native";

/** How long a browser keeps trying to focus something that is still being shown (see below). */
const WEB_FOCUS_FRAMES = 30;

/** Whether moveFocus is focusing something right now: a browser sends its focus event meanwhile. */
let moving = false;

/**
 * Whether the focus event being handled comes from moveFocus rather than from the person (Tab or
 * a click). Browsers only.
 */
export const focusMovedByApp = () => moving;

let movedTo: HostInstance | null = null;

/**
 * The control moveFocus last sent focus to. On a phone, where a screen reader moving on says
 * nothing, it is the last place focus is known to be.
 */
export const lastFocusMove = () => movedTo;

/**
 * Moves focus to a control: keyboard focus in a browser, the screen reader's focus on a phone.
 * Use it when something opens over a screen and when it closes again, so focus never stays behind
 * on content that is hidden or covered. Returns a function that stops a move still waiting.
 */
export function moveFocus(target: HostInstance | null | undefined): () => void {
  if (!target) return () => {};
  movedTo = target;
  if (Platform.OS !== "web") {
    AccessibilityInfo.sendAccessibilityEvent(target, "focus");
    return () => {};
  }
  // A browser can't focus something that isn't visible yet, and an entrance keeps its view hidden
  // until its animation starts a frame or two later: try again each frame until it takes.
  const element = target as unknown as HTMLElement;
  let frame = 0;
  let request = 0;
  const attempt = () => {
    // Without moving any scroll position: the browser would otherwise scroll the screen behind a
    // sheet that is still rising, to bring the control into view.
    moving = true;
    try {
      element.focus?.({ preventScroll: true });
    } finally {
      moving = false;
    }
    if (document.activeElement !== element && frame++ < WEB_FOCUS_FRAMES) {
      request = requestAnimationFrame(attempt);
    }
  };
  attempt();
  return () => cancelAnimationFrame(request);
}

/** Says a message out loud on a phone, after anything already being read (browsers use role=alert). */
export function announce(message: string) {
  if (Platform.OS === "web") return;
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}

/**
 * Props that take content out of reach while something covers it: no tapping into it with a
 * keyboard, and nothing in it is read out.
 */
export function outOfReach(covered: boolean) {
  if (!covered) return {};
  return {
    importantForAccessibility: "no-hide-descendants",
    accessibilityElementsHidden: true,
    "aria-hidden": true,
    // Browsers only (React Native for Web passes it through): nothing inside can take focus.
    ...(Platform.OS === "web" ? { inert: true } : {}),
  } as const;
}

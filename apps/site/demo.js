const open = document.getElementById("demo-open");
const close = document.getElementById("demo-close");
const tools = document.getElementById("demo-tools");
const demo = document.getElementById("hero-demo");
const screenshot = document.getElementById("hero-screenshot");
const template = document.getElementById("demo-template");

function isOnscreen(element) {
  const { top, bottom } = element.getBoundingClientRect();
  return top < window.innerHeight && bottom > 0;
}

// The web app needs a secure context for workout IDs. The static page also works from disk.
if (window.isSecureContext && window.location.protocol !== "file:") {
  document.getElementById("hero-gallery").hidden = true;
  open.hidden = false;

  open.addEventListener("click", () => {
    if (demo.hidden) {
      demo.append(template.content.cloneNode(true));
      screenshot.hidden = true;
      demo.hidden = false;
      tools.hidden = false;
      open.setAttribute("aria-expanded", "true");
    }
    if (!isOnscreen(demo)) {
      tools.scrollIntoView({ block: "start", behavior: "instant" });
    }
    if (isOnscreen(close)) {
      close.focus({ preventScroll: true });
    }
  });

  close.addEventListener("click", (event) => {
    // Removing the frame also discards the demo's in-memory session.
    demo.replaceChildren();
    demo.hidden = true;
    screenshot.hidden = false;
    tools.hidden = true;
    open.setAttribute("aria-expanded", "false");
    // Keyboard users need to see the restored focus when the opener is offscreen.
    open.focus({ preventScroll: event.detail > 0 });
  });
}

const open = document.getElementById("demo-open");
const close = document.getElementById("demo-close");
const tools = document.getElementById("demo-tools");
const demo = document.getElementById("hero-demo");
const screenshot = document.getElementById("hero-screenshot");
const template = document.getElementById("demo-template");

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
    close.focus({ preventScroll: true });
    const screen = demo.getBoundingClientRect();
    if (screen.top >= window.innerHeight || screen.bottom <= 0) {
      tools.scrollIntoView({ block: "start", behavior: "instant" });
    }
  });

  close.addEventListener("click", () => {
    // Removing the frame also discards the demo's in-memory session.
    demo.replaceChildren();
    demo.hidden = true;
    screenshot.hidden = false;
    tools.hidden = true;
    open.setAttribute("aria-expanded", "false");
    open.focus({ preventScroll: true });
  });
}

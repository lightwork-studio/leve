import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Keyboard, Platform, View } from "react-native";

/** The active workout supplies a timer to whichever sheet currently owns the keyboard. */
export const SheetKeyboardAccessory = createContext<ReactNode>(null);

export function KeyboardAccessory({ content }: { content?: ReactNode }) {
  const inherited = useContext(SheetKeyboardAccessory);
  const accessory = content === undefined ? inherited : content;
  return accessory ? <VisibleAccessory>{accessory}</VisibleAccessory> : null;
}

function VisibleAccessory({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [bottomInset, setBottomInset] = useState(0);
  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return;
      const viewport = window.visualViewport;
      // Mobile browsers can shrink only the visual viewport when the software keyboard appears.
      const resize = () =>
        setBottomInset(
          viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0,
        );
      const showFor = (target: EventTarget | null) =>
        setVisible(
          target instanceof Element && !!target.closest("input,textarea,[data-keyboard-accessory]"),
        );
      const focus = (event: FocusEvent) => showFor(event.target);
      const blur = (event: FocusEvent) => showFor(event.relatedTarget);
      showFor(document.activeElement);
      resize();
      viewport?.addEventListener("resize", resize);
      viewport?.addEventListener("scroll", resize);
      document.addEventListener("focusin", focus);
      document.addEventListener("focusout", blur);
      return () => {
        document.removeEventListener("focusin", focus);
        document.removeEventListener("focusout", blur);
        viewport?.removeEventListener("resize", resize);
        viewport?.removeEventListener("scroll", resize);
      };
    }
    setVisible(Keyboard.isVisible());
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  if (!visible) return null;
  // Mouse activation should leave the caret in the field. Buttons remain keyboard accessible.
  const web =
    Platform.OS === "web"
      ? {
          dataSet: { keyboardAccessory: true },
          onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
        }
      : {};
  return (
    <View {...web} style={{ paddingHorizontal: 8, marginBottom: bottomInset }}>
      {children}
    </View>
  );
}

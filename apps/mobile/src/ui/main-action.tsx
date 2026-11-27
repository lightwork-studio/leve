import { useIsFocused } from "expo-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * The main-action slot: one place above the tab bar for the action that matters most right now.
 * A tab screen offers its action with `MainAction` while it is the one on screen; the tabs show it
 * in `MainActionSlot`, unless something more pressing (a running workout) takes the place.
 */

interface SlotStore {
  offer(owner: string, content: ReactNode | null): void;
  current(): ReactNode | null;
  subscribe(listener: () => void): () => void;
}

function createSlotStore(): SlotStore {
  // The latest offer wins: only the screen on show offers anything, but while tabs change the
  // arriving one may offer before the leaving one has withdrawn.
  const offers = new Map<string, ReactNode>();
  const listeners = new Set<() => void>();
  let shown: ReactNode | null = null;
  return {
    offer(owner, content) {
      const had = offers.has(owner);
      if (content === null || content === undefined || content === false) {
        if (!had) return;
        offers.delete(owner);
      } else {
        offers.delete(owner);
        offers.set(owner, content);
      }
      shown = [...offers.values()].at(-1) ?? null;
      for (const listener of listeners) listener();
    },
    current: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const SlotContext = createContext<SlotStore | null>(null);
/** The week bar's slot, for the button beside "This week" (settings on Train, say). */
const BarSlotContext = createContext<SlotStore | null>(null);

/** Holds the slots for the screens inside it (the tabs). */
export function MainActionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createSlotStore);
  const [bar] = useState(createSlotStore);
  return (
    <SlotContext.Provider value={store}>
      <BarSlotContext.Provider value={bar}>{children}</BarSlotContext.Provider>
    </SlotContext.Provider>
  );
}

/**
 * Offers `children` as the main action while this screen is focused. Nothing is drawn where it is
 * written; pass `null` to offer nothing.
 */
export function MainAction({ children }: { children: ReactNode | null }) {
  return <Offer store={useContext(SlotContext)}>{children}</Offer>;
}

/** Offers `children` as the week bar's action while this screen is focused, as MainAction does. */
export function BarAction({ children }: { children: ReactNode | null }) {
  return <Offer store={useContext(BarSlotContext)}>{children}</Offer>;
}

function Offer({ store, children }: { store: SlotStore | null; children: ReactNode | null }) {
  const focused = useIsFocused();
  const owner = useId();
  // Every render offers the latest content, so the slot always shows the screen's current action.
  useLayoutEffect(() => {
    store?.offer(owner, focused ? children : null);
  });
  useEffect(() => () => store?.offer(owner, null), [store, owner]);
  return null;
}

/**
 * Where the main action is drawn. `render` gets what the focused screen offers (or null) and
 * decides what fills the slot, so something more pressing can take its place.
 */
export function MainActionSlot({ render }: { render: (offered: ReactNode | null) => ReactNode }) {
  return render(useOffered(useContext(SlotContext)));
}

/** What the focused screen offers for the week bar, or null. */
export function useBarAction(): ReactNode | null {
  return useOffered(useContext(BarSlotContext));
}

function useOffered(store: SlotStore | null): ReactNode | null {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.current ?? nothing,
    store?.current ?? nothing,
  );
}

const noSubscribe = () => () => {};
const nothing = () => null;

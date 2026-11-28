import { useAuth, useUser } from "@clerk/expo";
import { fetch as expoFetch } from "expo/fetch";
import Constants from "expo-constants";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { AccountSection } from "../account/account-section";
import { signInProblem, useAppleSignIn } from "../account/apple-sign-in.ts";
import { AppleSignInButton } from "../account/apple-sign-in-button.tsx";
import { useAppData } from "../data/app-data.tsx";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { radius, space, type } from "../theme.ts";
import { ActionRow, SettingRow } from "../ui/choice-row.tsx";
import { CommitButton } from "../ui/commit-button.tsx";
import { Dialog, DialogField } from "../ui/dialog.tsx";
import { announce } from "../ui/focus.ts";
import { Group, Row } from "../ui/group.tsx";
import { haptic } from "../ui/haptics.ts";
import { CheckIcon } from "../ui/icons.tsx";
import { themedStyles, useColors, useStyles } from "../ui/themed.ts";
import {
  PAIRING_PROBLEMS,
  PairingError,
  type PairingLink,
  pair,
  parsePairingLink,
  serverLabel,
} from "./own-server.ts";
import { chooseBuiltInServer, chooseOwnServer } from "./own-server-store.ts";
import { leveSyncAvailable, ownServerAvailable, syncServerUrl } from "./sync-config.ts";
import { turnSyncOff } from "./sync-destination.ts";
import { setSignedOutOnPurpose, setSyncPaused, syncPaused } from "./sync-preferences.ts";
import { unsyncedChanges } from "./sync-session.ts";
import { useServerChoice } from "./use-server-choice.ts";

const SAVE_FAILED = "This phone couldn't save the change. Try again.";
const SIGN_OUT_FAILED = "Signing out didn't work. Check the connection and try again.";

type Destination = "local" | "leve" | "server";
type Step = "choose" | "leve" | "local" | "link" | "pair" | "signOut";

interface LeveAccount {
  loaded: boolean;
  signedIn: boolean;
  userId: string | null;
  email?: string | undefined;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
}

/** All sync destinations share one section. Builds without managed sync still support account setup. */
export function SyncServerSection({ link = null }: { link?: PairingLink | null }) {
  const ownAvailable = ownServerAvailable();
  if (leveSyncAvailable()) return <ManagedSection link={link} ownAvailable={ownAvailable} />;
  return (
    <>
      {ownAvailable ? <Section link={link} ownAvailable /> : null}
      <AccountSection />
    </>
  );
}

function ManagedSection({
  link,
  ownAvailable,
}: {
  link: PairingLink | null;
  ownAvailable: boolean;
}) {
  const { isLoaded, isSignedIn, userId, signOut } = useAuth();
  const { user } = useUser();
  const signIn = useAppleSignIn();
  return (
    <Section
      link={ownAvailable ? link : null}
      ownAvailable={ownAvailable}
      leve={{
        loaded: isLoaded,
        signedIn: !!isSignedIn,
        userId: userId ?? null,
        email: user?.primaryEmailAddress?.emailAddress,
        signIn,
        signOut: () => signOut(),
      }}
    />
  );
}

function Section({
  link,
  ownAvailable,
  leve,
}: {
  link: PairingLink | null;
  ownAvailable: boolean;
  leve?: LeveAccount;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { store } = useAppData();
  const bound = store.syncState();
  const choice = useServerChoice();
  const paused = useSyncExternalStore(subscribeDevicePreferences, syncPaused, syncPaused);
  const own = ownAvailable && typeof choice === "object" ? choice : null;
  const boundToLeve = bound.server === syncServerUrl && bound.account !== null;
  const leveSelected =
    leve && choice !== "local" && (leve.signedIn || choice === "leve" || boundToLeve);
  const destination: Destination = own ? "server" : leveSelected ? "leve" : "local";
  const signInNeeded = destination === "leve" && !leve?.signedIn;
  const checking = choice === undefined || (!own && choice !== "local" && leve?.loaded === false);
  const status =
    destination === "local"
      ? "Sync off"
      : paused
        ? "Paused · changes wait here"
        : signInNeeded
          ? "Sign-in needed"
          : "Sync on";
  const host = own ? serverLabel(own.server) : null;
  const [step, setStep] = useState<Step | null>(link ? "pair" : null);
  const [entry, setEntry] = useState<PairingLink | string>(link ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const lastLink = useRef(link);
  const pairing = typeof entry === "string" ? parsePairingLink(entry) : entry;

  useEffect(() => {
    if (!link || link === lastLink.current || busy) return;
    lastLink.current = link;
    setProblem(null);
    setEntry(link);
    setStep("pair");
  }, [link, busy]);

  const open = (next: Step) => {
    if (working.current) return;
    setProblem(null);
    if (next === "link") setEntry("");
    setStep(next);
  };
  const editLink = () => {
    if (working.current) return;
    setProblem(null);
    setStep("link");
  };
  const close = () => {
    if (working.current) return;
    setStep(null);
    setProblem(null);
    setEntry("");
  };
  const report = (message: string) => {
    haptic.warning();
    announce(message);
    setProblem(message);
    setAttempt((n) => n + 1);
  };
  const saved = () => {
    haptic.success();
    setProblem(null);
    setStep(null);
    setEntry("");
  };
  const run = async (work: () => Promise<void>, failure: (error: unknown) => string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      report(failure(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const changePause = (value: boolean) => {
    setSyncPaused(value);
    haptic.select();
    announce(value ? "Sync paused" : "Sync resumed");
  };

  const connectLeve = async () => {
    if (!leve?.loaded) return;
    let signedIn = leve.signedIn;
    await run(
      async () => {
        signedIn = signedIn || (await leve.signIn());
        if (!signedIn) return;
        // Keep the old destination until Apple sign-in has completed.
        chooseBuiltInServer(store.syncState());
        setSignedOutOnPurpose(false);
        setSyncPaused(false);
        saved();
      },
      (error) => (signedIn ? SAVE_FAILED : signInProblem(error)),
    );
  };
  const connectOwn = async () => {
    if (!pairing) return;
    let paired = false;
    await run(
      async () => {
        const server = await pair(pairing, Constants.deviceName ?? "iPhone", expoFetch);
        paired = true;
        chooseOwnServer(server, store.syncState());
        setSyncPaused(false);
        announce(`Connected to ${serverLabel(server.server)}`);
        saved();
      },
      (error) =>
        error instanceof PairingError
          ? PAIRING_PROBLEMS[error.problem]
          : paired
            ? "This phone couldn't save the connection. Ask for a new pairing link and try again."
            : "Something went wrong while connecting. Try again.",
    );
  };

  const chooseLeve = () => (destination === "leve" && !signInNeeded ? close() : open("leve"));
  const deviceOnly = () => (destination === "local" ? close() : open("local"));
  const title = destination === "local" ? "On this iPhone" : destination === "leve" ? "Leve" : host;
  const detail = own
    ? own.accountName
      ? `Account ${own.accountName}`
      : "Your own server"
    : destination === "leve"
      ? signInNeeded
        ? "Sign in with Apple"
        : (leve?.email ?? "Signed in with Apple")
      : "Workouts stay on this phone";
  const note =
    destination !== "local" && paused
      ? "New workouts and changes stay on this phone until you resume sync."
      : null;

  let dialog: { label: string; title: string; content: React.ReactNode } | null = null;
  if (step === "choose") {
    const current = <CheckIcon color={c.fg} size={16} />;
    dialog = {
      label: "Sync destination",
      title: "Where should workouts sync?",
      content: (
        <View style={styles.options}>
          {leve?.loaded ? (
            <Row
              title="Leve"
              detail={
                destination === "leve"
                  ? signInNeeded
                    ? "Current destination · sign in with Apple"
                    : "Current destination"
                  : leve.signedIn
                    ? "Signed in with Apple"
                    : "Sign in with Apple"
              }
              end={destination === "leve" ? current : null}
              chevron={destination !== "leve" || signInNeeded}
              onPress={chooseLeve}
            />
          ) : null}
          {ownAvailable ? (
            <Row
              title={host ?? "Your own server"}
              detail={
                own
                  ? "Current destination · pair again or use another server"
                  : "Use a one-time pairing link"
              }
              end={own ? current : null}
              chevron
              divider={!!leve?.loaded}
              onPress={() => open("link")}
            />
          ) : null}
          <Row
            title="On this iPhone"
            detail="Keep workouts on this phone"
            chevron
            divider
            onPress={deviceOnly}
          />
        </View>
      ),
    };
  } else if (step === "leve") {
    dialog = {
      label: "Sync with Leve",
      title: leve?.signedIn ? "Use your Leve account" : "Back up with Apple",
      content: (
        <>
          <Text style={styles.body}>
            {leve?.signedIn && leve.email
              ? `This phone will sync with ${leve.email}.`
              : "Sign in with Apple to sync workouts with your Leve account."}
            {own ? " You can review what to bring to Leve before anything moves." : ""}
          </Text>
          <View style={styles.actions}>
            {leve?.signedIn ? (
              <CommitButton
                label={busy ? "Switching…" : "Switch to Leve"}
                busy={busy}
                onPress={() => void connectLeve()}
              />
            ) : (
              <AppleSignInButton busy={busy} onPress={() => void connectLeve()} />
            )}
          </View>
        </>
      ),
    };
  } else if (step === "link") {
    dialog = {
      label: "Your own server",
      title: "Paste the pairing link",
      content: (
        <>
          <DialogField
            accessibilityLabel="Pairing link"
            value={typeof entry === "string" ? entry : ""}
            onChangeText={(value) => {
              setEntry(value);
              setProblem(null);
            }}
            placeholder="Pairing link"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            hint="From whoever runs the server. It works once."
            {...(problem ? { error: problem } : {})}
            attempt={attempt}
          />
          <View style={styles.actions}>
            <CommitButton
              label="Review server"
              onPress={() => {
                if (!pairing) report("Paste the whole pairing link, starting with https://");
                else open("pair");
              }}
            />
          </View>
        </>
      ),
    };
  } else if (step === "pair" && pairing) {
    const name = serverLabel(pairing.server);
    dialog = {
      label: "Check the server",
      title: "Connect to this server?",
      content: (
        <>
          <Text style={styles.host}>{name}</Text>
          <Text style={styles.body}>
            {destination === "leve" ? "Leve will stop syncing. Your Apple sign-in is kept. " : ""}
            This phone will sync its workouts with {name}. Connect only to a server you trust.
          </Text>
          {choice === undefined ? (
            <Text style={styles.problem}>Unlock this iPhone before connecting.</Text>
          ) : null}
          <View style={styles.actions}>
            <CommitButton
              label={busy ? "Connecting…" : `Connect to ${name}`}
              busy={busy}
              disabled={choice === undefined}
              onPress={() => void connectOwn()}
            />
            {typeof entry === "string" && !busy ? (
              <ActionRow label="Edit pairing link" onPress={editLink} />
            ) : null}
          </View>
        </>
      ),
    };
  } else if (step === "local") {
    dialog = {
      label: "Turn sync off",
      title: "Keep workouts on this iPhone?",
      content: (
        <>
          <Text style={styles.body}>
            This phone will stop syncing with {host ?? "Leve"}. Your workouts stay on this phone.
            {leve?.signedIn ? " You stay signed in to Leve." : ""}
          </Text>
          <View style={styles.actions}>
            <CommitButton
              label="Turn sync off"
              busy={busy}
              onPress={() =>
                void run(
                  async () => {
                    turnSyncOff();
                    saved();
                  },
                  () => SAVE_FAILED,
                )
              }
            />
            <ActionRow
              label={paused ? "Keep it paused" : "Pause instead"}
              onPress={() => {
                changePause(true);
                close();
              }}
            />
          </View>
        </>
      ),
    };
  } else if (step === "signOut" && leve?.signedIn && destination !== "leve") {
    const waiting = boundToLeve && bound.account === leve.userId ? unsyncedChanges(store) : 0;
    dialog = {
      label: "Sign out of Leve",
      title: "Sign out of Leve?",
      content: (
        <>
          <Text style={styles.body}>
            {waiting === 1
              ? "1 change hasn't synced. It stays on this phone and waits for this Leve account."
              : waiting > 1
                ? `${waiting} changes haven't synced. They stay on this phone and wait for this Leve account.`
                : "Your workouts stay on this phone. Switching to Leve again will ask you to sign in."}
          </Text>
          <View style={styles.actions}>
            <CommitButton
              label={busy ? "Signing out…" : "Sign out of Leve"}
              busy={busy}
              onPress={() =>
                void run(
                  async () => {
                    await leve.signOut();
                    saved();
                  },
                  () => SIGN_OUT_FAILED,
                )
              }
            />
          </View>
        </>
      ),
    };
  }

  return (
    <>
      <Group label="Sync" {...(note ? { footnote: note } : {})}>
        {checking ? (
          <SettingRow label="Checking sync settings…">{null}</SettingRow>
        ) : (
          <>
            <View style={styles.destination}>
              <View style={styles.destinationHead}>
                <View style={styles.glyph} aria-hidden>
                  <DestinationIcon destination={destination} color={c.fg} />
                </View>
                <View style={styles.name}>
                  <Text style={[styles.title, own && styles.serverName]}>{title}</Text>
                  <Text style={styles.detail}>{detail}</Text>
                </View>
              </View>
              <View style={styles.status}>
                <View
                  style={[
                    styles.dot,
                    destination !== "local" && !paused && !signInNeeded && styles.on,
                  ]}
                />
                <Text style={styles.statusText}>{status}</Text>
              </View>
            </View>
            {destination === "local" ? (
              <>
                {leve?.loaded ? (
                  <Row
                    title="Sync with Leve"
                    detail={leve.signedIn ? "Use your Leve account" : "Sign in with Apple"}
                    chevron
                    divider
                    onPress={chooseLeve}
                  />
                ) : null}
                {ownAvailable ? (
                  <Row
                    title="Use your own server"
                    detail="Pair with a one-time link"
                    chevron
                    divider
                    onPress={() => open("link")}
                  />
                ) : null}
              </>
            ) : (
              <>
                {signInNeeded ? (
                  <Row title="Sign in with Apple" chevron divider onPress={chooseLeve} />
                ) : null}
                <ActionRow
                  label={paused ? "Resume sync" : "Pause sync"}
                  divider
                  onPress={() => changePause(!paused)}
                />
                <Row title="Change destination" chevron divider onPress={() => open("choose")} />
              </>
            )}
          </>
        )}
      </Group>
      {!checking && destination !== "leve" && leve?.signedIn ? (
        <Group
          label="Leve account"
          aside="Idle"
          footnote="Your sign-in is kept so you can switch back to Leve."
        >
          <SettingRow label="Signed in with Apple" {...(leve.email ? { hint: leve.email } : {})}>
            {null}
          </SettingRow>
          <ActionRow label="Sign out of Leve" divider onPress={() => open("signOut")} />
        </Group>
      ) : null}
      {dialog ? (
        <Dialog
          eyebrow={dialog.label}
          label={dialog.title}
          bottom={step !== "link"}
          onClose={close}
        >
          <Text accessibilityRole="header" style={styles.heading}>
            {dialog.title}
          </Text>
          {dialog.content}
          {problem && step !== "link" ? <Text style={styles.problem}>{problem}</Text> : null}
        </Dialog>
      ) : null}
    </>
  );
}

function DestinationIcon({ destination, color }: { destination: Destination; color: string }) {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {destination === "local" ? (
        <>
          <Rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
          <Line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
        </>
      ) : destination === "leve" ? (
        <Path d="M7 18.5h10.2a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5Z" />
      ) : (
        <>
          <Rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
          <Rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
          <Path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6" />
        </>
      )}
    </Svg>
  );
}

const sheet = themedStyles((c) => ({
  destination: { padding: space.lg },
  destinationHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  glyph: {
    width: 44,
    height: 44,
    borderRadius: radius.chip,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { flex: 1, minWidth: 0 },
  title: { ...type.heading, color: c.fg },
  serverName: { ...type.value, fontSize: 17, lineHeight: 22, color: c.fg },
  detail: { ...type.caption, color: c.fg2, marginTop: space.xs },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.fg3 },
  on: { backgroundColor: c.fg },
  statusText: { ...type.label, color: c.fg2, flexShrink: 1 },
  heading: { ...type.heading, color: c.fg, marginTop: space.sm },
  body: { ...type.body, color: c.fg2, marginTop: space.sm },
  host: {
    ...type.value,
    fontSize: 18,
    lineHeight: 24,
    color: c.fg,
    backgroundColor: c.s2,
    padding: space.md,
    borderRadius: radius.input,
    marginTop: space.md,
  },
  actions: { marginTop: space.lg },
  options: {
    marginTop: space.md,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: c.line2,
    overflow: "hidden",
  },
  problem: { ...type.caption, color: c.alert, marginTop: space.sm },
}));

import { fetch as expoFetch } from "expo/fetch";
import Constants from "expo-constants";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { space, type } from "../theme.ts";
import { ActionRow, SettingRow } from "../ui/choice-row.tsx";
import { Dialog, DialogField } from "../ui/dialog.tsx";
import { announce } from "../ui/focus.ts";
import { Group } from "../ui/group.tsx";
import { haptic } from "../ui/haptics.ts";
import { themedStyles, useStyles } from "../ui/themed.ts";
import {
  type OwnServer,
  PAIRING_PROBLEMS,
  PairingError,
  type PairingLink,
  pair,
  parsePairingLink,
  serverLabel,
} from "./own-server.ts";
import {
  chooseBuiltInServer,
  chooseOwnServer,
  ownServer,
  subscribeServerChoice,
} from "./own-server-store.ts";
import { builtInServerConfigured, ownServerAvailable, syncServerUrl } from "./sync-config.ts";
import { setSyncPaused, syncPaused } from "./sync-preferences.ts";

const OWN_NOTE = "Changes stay on this phone while a server switch is waiting for your answer.";
const OWN_PAUSED_NOTE =
  "Sync is paused. New workouts and changes stay on this phone until you resume it.";
const BUILT_IN_NOTE =
  "To sync with a server you or someone you trust runs, open the pairing link its operator gives you, or paste it here.";

/** The server choice in Settings: the build's own server, or one paired with a link. */
export function SyncServerSection({ link }: { link?: PairingLink | null }) {
  if (!ownServerAvailable()) return null;
  return <Section link={link ?? null} />;
}

function useServerChoice(): OwnServer | null {
  const [, setVersion] = useState(0);
  useEffect(() => subscribeServerChoice(() => setVersion((n) => n + 1)), []);
  return ownServer();
}

function Section({ link }: { link: PairingLink | null }) {
  const own = useServerChoice();
  const [connecting, setConnecting] = useState<PairingLink | "paste" | null>(link);
  const [problem, setProblem] = useState<string | null>(null);
  // A link opened while Settings is already showing.
  useEffect(() => {
    if (link) setConnecting(link);
  }, [link]);
  const builtIn = builtInServerConfigured();
  // A paired server has no account section (that is for the build's own sign-in), so pausing and
  // resuming sync live here for it.
  const [, setPreferences] = useState(0);
  useEffect(() => subscribeDevicePreferences(() => setPreferences((n) => n + 1)), []);
  const paused = !!own && syncPaused();
  return (
    <Group
      label="Sync server"
      footnote={problem ?? (paused ? OWN_PAUSED_NOTE : own ? OWN_NOTE : BUILT_IN_NOTE)}
    >
      <SettingRow
        label={own ? serverLabel(own.server) : builtIn ? "Leve" : "None"}
        hint={
          own
            ? own.accountName
              ? `Account ${own.accountName}`
              : "Your own server"
            : builtIn
              ? serverLabel(syncServerUrl)
              : "Workouts stay on this phone"
        }
      >
        {null}
      </SettingRow>
      {own ? (
        <ActionRow
          label={paused ? "Resume sync" : "Pause sync"}
          divider
          accessibilityHint={
            paused
              ? "Syncs this phone with the server again"
              : "Stops syncing until you resume. Changes stay on this phone"
          }
          onPress={() => setSyncPaused(!paused)}
        />
      ) : null}
      <ActionRow
        label={own ? "Connect to another server" : "Connect to your own server"}
        divider
        onPress={() => setConnecting("paste")}
      />
      {own ? (
        <ActionRow
          label={builtIn ? "Use Leve's server" : "Disconnect"}
          divider
          accessibilityHint={
            builtIn
              ? "Asks first if anything on this phone hasn't synced"
              : "Changes stay on this phone, and every screen says it isn't syncing"
          }
          onPress={() => {
            try {
              chooseBuiltInServer();
              setProblem(null);
            } catch {
              const message = "This phone couldn't save the change. Try again.";
              haptic.warning();
              setProblem(message);
              announce(message);
            }
          }}
        />
      ) : null}
      {connecting ? (
        <ConnectDialog
          initial={connecting === "paste" ? null : connecting}
          onClose={() => setConnecting(null)}
        />
      ) : null}
    </Group>
  );
}

/**
 * Pairs the phone with a server from its link. It always names the server and asks before
 * connecting: a link anyone sent could point anywhere, and connecting uploads this phone's
 * workouts there.
 */
function ConnectDialog({ initial, onClose }: { initial: PairingLink | null; onClose: () => void }) {
  const styles = useStyles(sheet);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const parsed = initial ?? (text ? parsePairingLink(text) : null);

  const connect = async () => {
    if (working.current) return;
    if (!parsed) {
      setProblem("Paste the whole pairing link, starting with https://");
      setAttempt((n) => n + 1);
      haptic.warning();
      return;
    }
    working.current = true;
    setBusy(true);
    setProblem(null);
    let paired: OwnServer | null = null;
    try {
      paired = await pair(parsed, Constants.deviceName ?? "iPhone", expoFetch);
      chooseOwnServer(paired);
      haptic.success();
      announce(`Connected to ${serverLabel(paired.server)}`);
      onClose();
    } catch (error) {
      const message =
        error instanceof PairingError
          ? PAIRING_PROBLEMS[error.problem]
          : paired
            ? // The code is used up by now: only a new one can pair this phone.
              "This phone couldn't save the connection. Ask for a new pairing link and try again."
            : "Something went wrong while connecting. Try again.";
      setProblem(message);
      setAttempt((n) => n + 1);
      haptic.warning();
      announce(message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      eyebrow="Connect to a sync server"
      // Not while connecting: the answer would still switch the phone after the dialog closed.
      onClose={() => {
        if (!working.current) onClose();
      }}
      confirm={{
        label: busy
          ? "Connecting…"
          : parsed
            ? `Connect to ${serverLabel(parsed.server)}`
            : "Connect",
        onPress: () => void connect(),
      }}
    >
      {initial ? null : (
        <DialogField
          value={text}
          onChangeText={(value) => {
            setText(value);
            setProblem(null);
          }}
          placeholder="Pairing link"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          autoFocus
          hint="From whoever runs the server. It works once."
          {...(problem ? { error: problem } : {})}
          attempt={attempt}
        />
      )}
      <Text style={styles.body}>
        {parsed
          ? `This phone will sync its workouts with ${serverLabel(parsed.server)}. Connect only to a server you trust.`
          : "Paste the link, then check the server it names."}
      </Text>
      {initial && problem ? <Text style={styles.body}>{problem}</Text> : null}
    </Dialog>
  );
}

const sheet = themedStyles((c) => ({
  body: { ...type.body, fontSize: 15, lineHeight: 22, color: c.fg2, marginTop: space.sm },
}));

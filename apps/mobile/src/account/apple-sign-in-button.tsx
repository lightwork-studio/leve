import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { View } from "react-native";
import { radius, space } from "../theme.ts";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";

export function AppleSignInButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const styles = useStyles(sheet);
  const appearance = useAppearance();
  return (
    <View
      style={[styles.signIn, busy && styles.waiting]}
      pointerEvents={busy ? "none" : "auto"}
      accessibilityElementsHidden={busy}
    >
      <AppleAuthenticationButton
        buttonType={AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={
          appearance === "paper"
            ? AppleAuthenticationButtonStyle.BLACK
            : AppleAuthenticationButtonStyle.WHITE
        }
        cornerRadius={radius.button}
        style={styles.appleButton}
        onPress={onPress}
      />
    </View>
  );
}

const sheet = themedStyles(() => ({
  signIn: { padding: space.md },
  appleButton: { height: 44, width: "100%" },
  waiting: { opacity: 0.5 },
}));

import { Text, View } from "react-native";
import { font } from "../../theme.ts";
import { NoteIcon } from "../icons.tsx";
import { Tap } from "../tap.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";

/**
 * The workout's notes as a square tile beside its muscles: the note icon, with how many notes
 * there are (this workout's and those pinned from earlier ones) as a badge. A sync problem with a
 * note shows as "!" in the warning colour instead.
 */
export function WorkoutNotesTile({
  count,
  coachReplies,
  needsReview,
  onPress,
}: {
  count: number;
  coachReplies: number;
  needsReview: boolean;
  onPress: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const label = [
    `Workout notes, ${count}`,
    coachReplies > 0 ? `${coachReplies} coach ${coachReplies === 1 ? "reply" : "replies"}` : null,
    needsReview ? "review sync issue" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.tile}
    >
      <NoteIcon color={c.fg2} size={20} />
      {(needsReview || count > 0) && (
        <View style={[styles.badge, needsReview && styles.badgeAlert]}>
          <Text style={[styles.badgeText, needsReview && styles.badgeAlertText]}>
            {needsReview ? "!" : count > 99 ? "99+" : String(count)}
          </Text>
        </View>
      )}
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  tile: {
    width: 52,
    height: 52,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.s1,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -7,
    right: -7,
    minWidth: 21,
    height: 21,
    borderRadius: 11,
    paddingHorizontal: 2,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
    // A ring in the ground's colour keeps it apart from the tile's edge.
    borderWidth: 2,
    borderColor: c.bg,
  },
  badgeAlert: { backgroundColor: c.alert },
  badgeText: { ...font.monoBold, fontSize: 9.5, lineHeight: 13, color: c.bg },
  badgeAlertText: { color: c.bg },
}));

import {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  SlideInDown,
  SlideOutDown,
  ZoomIn,
} from "react-native-reanimated";

/**
 * Leve's motion, in one place so screens move alike. Movement is short and settles without
 * bouncing far: it shows what changed, then gets out of the way. Reanimated follows the system's
 * reduce-motion setting for all of these, so they become instant there.
 *
 * Curves are Bézier curves: browsers only get those (anything else falls back to linear there).
 */

/** Things arriving and settling: fast at first, easing into place (ease-out cubic). */
export const easeOut = Easing.bezier(0.33, 1, 0.68, 1);
/** Emphasised moves that should feel decisive, such as a press or a tab change. */
export const emphasised = Easing.bezier(0.2, 0, 0, 1);

/** Springs for things that follow a touch: quick, with a little settle. */
export const spring = { damping: 22, stiffness: 320, mass: 0.7 } as const;

/** How far a pressed control shrinks. */
export const pressScale = 0.97;

/** How long a standard entrance (see Enter) takes. */
export const enterDuration = 240;

/** Something that moves to make room or close a gap. */
export const layout = LinearTransition.duration(220).easing(easeOut);

/**
 * A surface that rises into place from the bottom edge (the rest timer, a sheet). It slides in
 * whole and opaque (fading it as well would show what's behind through it) on a timed curve that
 * lands without overshooting: a spring travelling the screen's height lifts off its edge on phones,
 * and browsers don't run springs.
 */
export const rise = SlideInDown.duration(340).easing(Easing.bezier(0.32, 0.72, 0, 1));
/** Its way out, as a fresh animation for each user (see useExit). */
export const sinkOut = () => SlideOutDown.duration(220).easing(Easing.bezier(0.4, 0, 1, 1));
/** A plain fade out, as a fresh animation for each user (see useExit). */
export const fadeOut = () => FadeOut.duration(140);

/**
 * A confirmation mark, such as a logged set's tick. A new animation each call: Reanimated's builder
 * methods change the instance, so a shared one must never get a delay.
 */
export const pop = (delay = 0) => ZoomIn.springify().damping(14).stiffness(260).delay(delay);

export const fade = FadeIn.duration(180);

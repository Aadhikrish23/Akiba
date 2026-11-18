import { Link, type Href } from 'expo-router';
import { useId, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MIN_TARGET, useTheme } from '../theme/theme';

/**
 * The shelf's building blocks for the app (doc 08 §3): hairline borders, near-square corners, ink
 * for the primary action. Every control is at least 44 pt tall and wide, has an accessibility role
 * and a name a screen reader can say, and never relies on colour alone.
 */

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const base: ViewStyle = {
    flexGrow: 1,
    padding: theme.space(4),
    gap: theme.space(5),
    backgroundColor: theme.colors.paper,
  };
  return scroll ? (
    <ScrollView
      style={{ backgroundColor: theme.colors.paper }}
      contentContainerStyle={[base, style]}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[base, { flex: 1 }, style]}>{children}</View>
  );
}

export function Heading({ children, level = 1 }: { children: ReactNode; level?: 1 | 2 }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: theme.colors.ink,
        fontFamily: theme.fonts.serif,
        fontWeight: '600',
        fontSize: level === 1 ? theme.type.xl : theme.type.lg,
        lineHeight: level === 1 ? 32 : 24,
      }}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  style,
  ...rest
}: { children: ReactNode; style?: StyleProp<TextStyle> } & Omit<
  React.ComponentProps<typeof Text>,
  'style' | 'children'
>) {
  const theme = useTheme();
  return (
    <Text {...rest} style={[{ color: theme.colors.ink, fontSize: theme.type.base * 1.07 }, style]}>
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const theme = useTheme();
  return (
    <Text style={[{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1 }, style]}>
      {children}
    </Text>
  );
}

interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'outline' | 'link';
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** When the spoken name must say more than the visible label ("Mark as read: episode 7 of …"). */
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

/**
 * A button. While busy it keeps its place and focus but ignores presses, and says so to assistive
 * technology.
 */
export function Button({
  label,
  onPress,
  variant = 'outline',
  busy = false,
  disabled = false,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const filled = variant === 'primary';
  const link = variant === 'link';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={busy ? undefined : onPress}
      testID={testID}
      hitSlop={link ? 8 : 0}
      style={({ pressed }) => ({
        minHeight: MIN_TARGET + 4,
        minWidth: MIN_TARGET,
        paddingHorizontal: link ? 0 : theme.space(5),
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space(2),
        borderRadius: theme.radius,
        borderWidth: link ? 0 : 1,
        borderColor: theme.colors.ink,
        backgroundColor: filled ? theme.colors.ink : 'transparent',
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        alignSelf: link ? 'flex-start' : undefined,
      })}
    >
      {busy && <ActivityIndicator color={filled ? theme.colors.paper : theme.colors.ink} />}
      <Text
        style={{
          color: filled ? theme.colors.paper : theme.colors.ink,
          fontSize: theme.type.base * 1.07,
          fontWeight: '500',
          textDecorationLine: link ? 'underline' : 'none',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

interface FieldProps extends Omit<TextInputProps, 'style' | 'accessibilityLabel'> {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
}

/** A labelled text field: the label is visible above it and is the field's accessible name. */
export function Field({ label, error, hint, ...input }: FieldProps) {
  const theme = useTheme();
  const id = useId();
  return (
    <View style={{ gap: theme.space(2) }}>
      <Text
        nativeID={`${id}-label`}
        style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1, fontWeight: '500' }}
      >
        {label}
      </Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={theme.colors.mute}
        style={{
          minHeight: input.multiline === true ? 120 : MIN_TARGET + 4,
          textAlignVertical: input.multiline === true ? 'top' : 'center',
          paddingVertical: input.multiline === true ? theme.space(3) : 0,
          borderWidth: 1,
          borderRadius: theme.radius,
          borderColor: error === undefined ? theme.colors.rule : theme.colors.accent,
          backgroundColor: theme.colors.raised,
          color: theme.colors.ink,
          paddingHorizontal: theme.space(3),
          fontSize: theme.type.base * 1.07,
        }}
      />
      {hint !== undefined && <Muted>{hint}</Muted>}
      {error !== undefined && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.accent, fontSize: theme.type.sm * 1.1, fontWeight: '500' }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

/** A message that is announced when it appears; errors interrupt, everything else waits its turn. */
export function Notice({
  tone = 'info',
  children,
  testID,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={{
        borderWidth: 1,
        borderRadius: theme.radius,
        borderColor: tone === 'error' ? theme.colors.accent : theme.colors.rule,
        padding: theme.space(3),
      }}
    >
      <Text style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1 }}>{children}</Text>
    </View>
  );
}

/** A text link to another screen: one tap target of at least 44 pt. */
export function TextLink({ href, children }: { href: Href; children: string }) {
  const theme = useTheme();
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={children}
        hitSlop={8}
        style={{ minHeight: MIN_TARGET, justifyContent: 'center', alignSelf: 'flex-start' }}
      >
        <Text
          style={{
            color: theme.colors.ink,
            textDecorationLine: 'underline',
            fontSize: theme.type.base * 1.07,
          }}
        >
          {children}
        </Text>
      </Pressable>
    </Link>
  );
}

/** Shown while the stored session is being looked up. */
export function Loading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.paper,
      }}
    >
      <ActivityIndicator color={theme.colors.ink} />
    </View>
  );
}

import { Pressable, ScrollView, Text, View } from 'react-native';
import { MIN_TARGET, useTheme } from '../theme/theme';

export interface Choice<T extends string> {
  readonly value: T | '';
  readonly label: string;
}

/**
 * A single choice from a short list (a filter): a row of chips that scrolls sideways. Each chip is
 * a radio button with its state spoken, and the chosen one is filled and underlined, not just
 * coloured. `value` is `''` for "no filter".
 */
export function Chips<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  choices: readonly Choice<T>[];
  value: T | '';
  onChange: (value: T | '') => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: theme.space(1) }}>
      <Text style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1, fontWeight: '500' }}>
        {label}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: theme.space(2) }}>
          {choices.map((choice) => {
            const selected = choice.value === value;
            return (
              <Pressable
                key={choice.value === '' ? 'any' : choice.value}
                accessibilityRole="radio"
                accessibilityLabel={choice.label}
                accessibilityState={{ checked: selected, disabled }}
                disabled={disabled}
                onPress={() => {
                  onChange(choice.value);
                }}
                hitSlop={4}
                style={{
                  minHeight: MIN_TARGET,
                  minWidth: MIN_TARGET,
                  paddingHorizontal: theme.space(3),
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: theme.radius,
                  borderWidth: theme.hairline,
                  borderColor: selected ? theme.colors.ink : theme.colors.rule,
                  backgroundColor: selected ? theme.colors.ink : 'transparent',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Text
                  style={{
                    color: selected ? theme.colors.paper : theme.colors.ink,
                    fontSize: theme.type.base * 1.07,
                    fontWeight: selected ? '600' : '400',
                  }}
                >
                  {choice.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

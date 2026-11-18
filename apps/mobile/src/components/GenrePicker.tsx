import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MIN_TARGET, useTheme } from '../theme/theme';
import { Button } from './ui';

/**
 * Choosing one genre from a long list: a button that says the current choice and opens a full
 * sheet of options. The sheet is announced as a dialog and closes with its own button (or the
 * system back gesture); the chosen option is marked with words, not just colour.
 */
export function GenrePicker({
  genres,
  value,
  onChange,
  disabled = false,
}: {
  genres: readonly string[];
  value: string;
  onChange: (genre: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const options = ['', ...genres];
  const close = () => {
    setOpen(false);
  };
  return (
    <View style={{ gap: theme.space(1) }}>
      <Text style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1, fontWeight: '500' }}>
        Genre
      </Text>
      <Button
        label={value === '' ? 'Any genre' : value}
        accessibilityLabel={`Genre: ${value === '' ? 'any' : value}. Change`}
        disabled={disabled || genres.length === 0}
        onPress={() => {
          setOpen(true);
        }}
      />
      <Modal visible={open} animationType="slide" onRequestClose={close} accessibilityViewIsModal>
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.paper }}>
          <View style={{ padding: theme.space(4), gap: theme.space(3), flex: 1 }}>
            <Text
              accessibilityRole="header"
              style={{
                color: theme.colors.ink,
                fontFamily: theme.fonts.serif,
                fontSize: theme.type.xl,
                fontWeight: '600',
              }}
            >
              Choose a genre
            </Text>
            <FlatList
              data={options}
              keyExtractor={(item) => (item === '' ? 'any' : item)}
              renderItem={({ item }) => {
                const selected = item === value;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityLabel={item === '' ? 'Any genre' : item}
                    accessibilityState={{ checked: selected }}
                    onPress={() => {
                      onChange(item);
                      close();
                    }}
                    style={{
                      minHeight: MIN_TARGET + 4,
                      justifyContent: 'center',
                      borderBottomWidth: theme.hairline,
                      borderColor: theme.colors.rule,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.ink,
                        fontSize: theme.type.base * 1.07,
                        fontWeight: selected ? '700' : '400',
                      }}
                    >
                      {item === '' ? 'Any genre' : item}
                      {selected ? ' (selected)' : ''}
                    </Text>
                  </Pressable>
                );
              }}
            />
            <Button label="Close" onPress={close} />
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

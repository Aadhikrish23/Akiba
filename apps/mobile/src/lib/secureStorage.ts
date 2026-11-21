import type { RefreshTokenStorage } from '@akiba/api-client';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'akiba.refresh-token';

/**
 * The refresh token lives in the platform's secure storage (Keychain on iOS, Keystore-backed
 * storage on Android) and nowhere else: not in AsyncStorage, not in a file, not in a log. It is
 * kept out of backups and device transfers (`THIS_DEVICE_ONLY`), so restoring a phone from a backup
 * does not carry a live session to another device, and it becomes readable after the first unlock
 * so the app can renew the session when it is started in the background.
 *
 * The web build of the app (used for development only) has no secure storage; there the token
 * stays in memory and the session ends with the page.
 */
export function createSecureRefreshTokenStorage(): RefreshTokenStorage {
  if (Platform.OS === 'web') {
    let memory: string | undefined;
    return {
      get: () => memory,
      set: (token) => {
        memory = token;
      },
    };
  }
  return {
    async get() {
      return (await SecureStore.getItemAsync(KEY)) ?? undefined;
    },
    async set(token) {
      if (token === undefined) {
        await SecureStore.deleteItemAsync(KEY);
        return;
      }
      await SecureStore.setItemAsync(KEY, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    },
  };
}

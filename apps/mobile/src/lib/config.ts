/**
 * Where the API lives. `EXPO_PUBLIC_API_URL` is read at build time (Expo inlines `EXPO_PUBLIC_*`
 * variables). The default suits a simulator talking to an API on the same machine; an Android
 * emulator reaches the host as 10.0.2.2 and a phone needs the machine's address on the network.
 */
export const API_BASE_URL: string =
  process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:3000/v1';

/** Sent as `X-Client: mobile/<version>`; must match the API's header pattern. */
export const CLIENT_VERSION = '0.1.0';

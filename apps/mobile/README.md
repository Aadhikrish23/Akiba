# @akiba/mobile

The Akiba app for iOS and Android: Expo (React Native), Expo Router, TypeScript.

It shares the API client (`@akiba/api-client`), the data types and wording (`@akiba/shared`) and the
design tokens (`@akiba/ui-tokens`) with the web app, so a rule written once holds on both.

## Running it

```bash
pnpm install
pnpm build:packages            # the workspace packages the app imports
pnpm --filter @akiba/mobile start
```

Point the app at an API with `EXPO_PUBLIC_API_URL` (read when the bundle is built; see
`.env.example`). The default, `http://localhost:3000/v1`, suits an iOS simulator. An Android emulator
reaches the machine it runs on as `10.0.2.2`, and a real phone needs the machine's address on the
network.

## Sessions

Mobile clients use the API's body transport (doc 07 §2): the refresh token is returned in the
response body and kept in the platform's secure storage (`expo-secure-store`: Keychain on iOS, a
Keystore-backed store on Android), never anywhere else. It is excluded from backups and device
transfers. The access token lives in memory only. The web build of the app, used for development,
has no secure storage: there the token stays in memory.

Emailed links (verify email, reset password) open in the browser, on the web app: the app does not
register for them.

## Checks

```bash
pnpm --filter @akiba/mobile typecheck
pnpm --filter @akiba/mobile test       # Jest + @testing-library/react-native, in-memory secure store
pnpm --filter @akiba/mobile build      # bundles the app for web and Android (Hermes), catching
                                       # anything Metro cannot resolve
```

Component tests run the real router, providers and API client over a fake network. What they cannot
show is how the app looks and feels on a device or simulator; that is checked by hand.

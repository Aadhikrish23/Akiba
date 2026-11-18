// Expo inlines `EXPO_PUBLIC_*` variables into the bundle at build time; `process.env` is how the
// code reads them.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/**
 * Jest for the Expo app. The packages below ship untranspiled ES modules, and pnpm keeps each one
 * under `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, so the usual jest-expo
 * allow-list is matched after that prefix. The workspace packages (@akiba/*) are plain ES modules
 * too.
 */
const TRANSFORMED = [
  '(jest-)?react-native',
  '@react-native(-community)?',
  'expo(nent)?',
  '@expo(nent)?/.*',
  '@expo-google-fonts/.*',
  'react-navigation',
  '@react-navigation/.*',
  'standard-navigation',
  'react-native-screens',
  'react-native-safe-area-context',
  '@akiba/.*',
].join('|');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // The first test of a cold run pays for transforming React Native and Expo Router.
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  testMatch: ['<rootDir>/src/**/*.test.ts?(x)'],
  transformIgnorePatterns: [`node_modules/(?!(?:[.]pnpm/)?(?:${TRANSFORMED}))`],
};

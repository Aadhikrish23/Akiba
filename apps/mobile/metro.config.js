// Metro finds the workspace packages (@akiba/*) on its own: Expo's default config understands
// monorepos and pnpm's symlinked node_modules.
// Metro reads this file as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);

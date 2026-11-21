/**
 * Jest setup: the device's secure storage is replaced by an in-memory map the tests can read, and
 * nothing is allowed to reach a real network (every test installs its own `fetch`).
 */
const mockSecureStore = new Map<string, string>();
export const secureStore = mockSecureStore;

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockSecureStore.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    mockSecureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockSecureStore.delete(key);
    return Promise.resolve();
  }),
}));

beforeEach(() => {
  secureStore.clear();
  globalThis.fetch = () => Promise.reject(new TypeError('network is not available in tests'));
});

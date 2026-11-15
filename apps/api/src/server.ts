import { createApp } from './app.js';

const DEFAULT_PORT = 3000;

function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, received "${raw}"`);
  }
  return port;
}

const port = resolvePort(process.env.PORT);

createApp().listen(port, () => {
  console.log(`api listening on port ${port}`);
});

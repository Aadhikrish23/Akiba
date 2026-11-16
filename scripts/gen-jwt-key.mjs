#!/usr/bin/env node
// Generate an Ed25519 signing key for the API's access tokens (doc 09 S-AUTH-5).
//
//   pnpm auth:gen-key          prints an AUTH_JWT_PRIVATE_JWK=... line for apps/api/.env plus the
//                              public half, which you need later when rotating
//   pnpm auth:gen-key --raw    prints only the private JWK JSON (for scripts and CI)
//
// The output IS A SECRET: put it in the environment / secret store, never in the repository.
// The key ID (`kid`) is the RFC 7638 thumbprint of the public key. Uses node:crypto only.
import { createHash, generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const { x, d } = privateKey.export({ format: 'jwk' });
// RFC 7638: SHA-256 over the required members in lexicographic order, no whitespace.
const kid = createHash('sha256')
  .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
  .digest('base64url');
const privateJwk = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x, d, kid });
const publicJwk = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x, kid });

if (process.argv.includes('--raw')) {
  process.stdout.write(`${privateJwk}\n`);
} else {
  process.stdout.write(
    [
      '# Signing key (SECRET). Set this in the API environment:',
      `AUTH_JWT_PRIVATE_JWK='${privateJwk}'`,
      '',
      '# Public half (not secret). When you rotate to a newer key, set this as',
      '# AUTH_JWT_PREVIOUS_PUBLIC_JWK for at least 15 minutes so issued tokens stay valid:',
      `# ${publicJwk}`,
      '',
    ].join('\n'),
  );
}

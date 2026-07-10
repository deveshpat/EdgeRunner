# Security

EdgeRunner is a **static** GitHub Pages frontend plus optional Kaggle/local
backends. There is **no EdgeRunner cloud** holding your keys or chats.

## Threat model (what we protect against)

| Threat | Mitigation |
|--------|------------|
| Token re-entry every visit | Encrypted device vault (IndexedDB) |
| Disk / backup scrape of browser profile | AES-256-GCM ciphertext at rest; optional passphrase (PBKDF2 600k) |
| Other websites reading data | Same-origin policy + non-extractable CryptoKeys |
| XSS → token theft | CSP, no `rehype-raw`, URL allowlist in markdown, minimal deps |
| Tab close leaving GPU on | `sendBeacon` shutdown + idle heartbeat watchdog on worker |
| Supply-chain install lag / build on Kaggle | Prebuilt wheels from our GitHub release (verify release assets) |

## What we do **not** claim

- **XSS on the EdgeRunner origin** while the vault is unlocked can still call
  WebCrypto and decrypt (same as any client-side password manager). Use the
  **passphrase** vault mode on shared machines and lock/wipe when done.
- **Kaggle** and **tunnel** operators can see traffic to those endpoints —
  use only for non-sensitive workloads or local backend mode.
- GitHub Pages meta CSP is weaker than HTTP headers; treat it as defense-in-depth.

## Crypto details

- **AEAD:** AES-256-GCM (Web Crypto)
- **KDF (passphrase mode):** PBKDF2-HMAC-SHA-256, 600 000 iterations, random 16-byte salt
- **Device mode:** non-extractable `CryptoKey` stored via IndexedDB structured clone
- **Secrets + chat bodies:** never written plaintext to `localStorage`

## Reporting

Open a private security advisory on the GitHub repo if you find an issue.

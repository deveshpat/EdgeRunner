/**
 * Public storage API — encrypted vault for secrets + chat.
 * Re-exports vault so existing imports keep working.
 */

export {
  type ChatRecord,
  type KaggleSecret,
  type StoredPrefs,
  type VaultMode,
  clearSecret,
  createVault,
  isUnlocked,
  loadChat,
  loadPrefs,
  loadSecret,
  lockVault,
  migrateLegacyIfNeeded,
  readMeta,
  saveChat,
  savePrefs,
  saveSecret,
  tryAutoUnlock,
  unlockDeviceVault,
  unlockWithPassphrase,
  vaultExists,
  wipeVault,
  getVaultMode,
} from "./vault";

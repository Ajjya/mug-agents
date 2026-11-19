/**
 * Folders the inbox must never open. In Gmail's IMAP every label is a folder, and these three groups are
 * not labels of ours: INBOX and the `[Gmail]/...` system folders (All Mail above all) hold the WHOLE
 * mailbox, including the bank, medical and job mail the access-control model keeps out.
 * A configured label that names one of them is refused at boot, and the client refuses to open it even
 * if it somehow got that far.
 */
export function isForbiddenFolder(path: string): boolean {
  const p = path.trim().toLowerCase();
  return (
    p === 'inbox' || p === '[gmail]' || p.startsWith('[gmail]/') || p.startsWith('[google mail]')
  );
}

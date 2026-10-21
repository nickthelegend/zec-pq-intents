// Every anchor the verifier ever sent, read from the escrow's own history: anchors are paid from the
// escrow wallet, and its full viewing key (published) shows every payment out of it. A view-only
// wallet made from that key lists them all, so a second head anchored for another audience cannot
// stay out of sight.
import type { AnchorSeen } from '@pqi/protocol';
import { valueTransfers, type ZingoConfig } from './zingo.js';

export async function anchorHistory(cfg: ZingoConfig, historyWallet: string): Promise<AnchorSeen[]> {
  return (await valueTransfers(cfg, historyWallet))
    .filter((t) => t.kind !== 'received' && !/fail/i.test(t.status))
    .flatMap((t) => t.memos.filter((m) => m.startsWith('pqi1:anchor:')).map((memo) => ({ txid: t.txid, memo })));
}

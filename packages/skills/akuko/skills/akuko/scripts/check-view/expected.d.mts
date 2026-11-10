// Types for expected.mjs (used by scripts/check-view.test.ts).
import type { AkukoProject, PendingSpend } from '../../schema/akuko-project.ts';

export declare const gateMoney: (n: number) => string;
export declare const STAGE_IDS: string[];
export declare function expectedMoney(p: AkukoProject): {
  currency: string | null;
  cap: number | null;
  spent: number | null;
  sunk: number;
  inFlight: number;
  leftIfApproved: number | null;
  ledgerTotal: number;
  jobs: { id: string; estimate: number; bound: number; status: PendingSpend['status']; stage: string }[];
};
export declare function expectedYourMove(p: AkukoProject): Record<'waiting-shots' | 'waiting-spend' | 'waiting-other', number>;
export declare const approveSpendText: (p: AkukoProject, job: PendingSpend) => string;
export declare function mutateProject(p: AkukoProject): AkukoProject;
export declare function removedAt(p: AkukoProject, u: object): string | undefined;

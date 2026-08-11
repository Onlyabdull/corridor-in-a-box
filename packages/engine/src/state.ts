// The corridor state machine — the spine. Every payment walks these states in
// order; recover() is the only thing that moves backwards. Persist the state +
// a monotonic version after each transition so a crashed run can be resumed and
// reconciled rather than lost.

export type CorridorState =
  | "created"
  | "quoted"
  | "compliant"
  | "opened"
  | "settling"
  | "retrying"
  | "settled"
  | "reconciled"
  | "completed"
  | "recovering"
  | "refunded"
  | "held"
  | "failed";

const NEXT: Record<CorridorState, readonly CorridorState[]> = {
  created: ["quoted", "failed"],
  quoted: ["compliant", "recovering", "failed"],
  compliant: ["opened", "recovering", "failed"],
  opened: ["settling", "recovering", "failed"],
  settling: ["settled", "retrying", "recovering", "failed"],
  // A settle attempt failed BEFORE money moved, so going round again is safe.
  // This is the only state that may re-enter `settling`.
  retrying: ["settling", "recovering", "failed"],
  settled: ["reconciled", "recovering", "failed"],
  reconciled: ["completed", "failed"],
  completed: [],
  // Terminal-bound. `recovering` is entered when a payment cannot proceed —
  // including AFTER settlement, when reconcile fails and funds are already on
  // the chain — so it must never lead back to `settling`.
  //
  // These were one state until a property test walked the graph and found that
  // `settled -> recovering -> settling` was reachable: a path that would
  // re-submit a payment that had already gone out. The engine's control flow
  // never took it, but this table is the guard that exists to catch a
  // control-flow bug, and it would not have caught that one. Splitting the two
  // kinds of recovery makes the double-spend unreachable by construction rather
  // than by careful reading of run.ts.
  recovering: ["refunded", "held", "failed"],
  refunded: [],
  held: [],
  failed: [],
};

export function canTransition(from: CorridorState, to: CorridorState): boolean {
  return NEXT[from].includes(to);
}

export const TERMINAL: ReadonlySet<CorridorState> = new Set([
  "completed",
  "refunded",
  "held",
  "failed",
]);

export function isTerminal(s: CorridorState): boolean {
  return TERMINAL.has(s);
}

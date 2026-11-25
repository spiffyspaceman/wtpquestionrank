// Which boards a vote counts toward, and which boards a voter may see. One definition, used by the Worker and the
// admin page's interval refresh. (analysis/analyze.ts keeps its own copy because that file is frozen.) No Workers
// types here, so the browser code can import it.
import { POOLED_ROLES, ROLES } from "../rating/config";

export const POOLS = ["all", "adults", ...ROLES] as const;
export type Pool = (typeof POOLS)[number];

export const ROLE_NAMES: Record<string, string> = {
  judge: "Judge",
  coach: "Coach",
  alumni: "Alumni",
  teacher: "Teacher",
  other: "Other",
  student: "Student",
};

export const isAdultRole = (role: string): boolean => (POOLED_ROLES as readonly string[]).includes(role);

/** Pools a first-presentation vote by this role counts toward. */
export function poolsForRole(role: string): Pool[] {
  return isAdultRole(role) ? ["all", role as Pool, "adults"] : ["all", role as Pool];
}

/** Pools a voter may see on the leaderboard: the pooled adults board and their own role's board. */
export function visiblePools(role: string): Pool[] {
  return ["adults", role as Pool];
}

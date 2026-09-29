/** Core JSON-compatible types for the DoG 0.9 protocol. */

export const DOG_SCHEMA_VERSION = "0.9" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GoalId = string;
export type ConstraintKind = "hard" | "soft";
export type GoalKind = "leaf" | "composite";
export type FailurePolicy = "fatal" | "tolerable" | "degrade";
export type GoalState =
	| "pending"
	| "running"
	| "success"
	| "failure"
	| "blocked"
	| "needs_human"
	| "cancelled"
	| "invalidated"
	| "partial"
	| "inherited";

export interface RefExpr {
	readonly op: "ref";
	readonly id: GoalId;
}

export interface AllExpr {
	readonly op: "all";
	readonly items: readonly BoolExpr[];
}

export interface AnyExpr {
	readonly op: "any";
	readonly items: readonly BoolExpr[];
}

export interface NotExpr {
	readonly op: "not";
	readonly item: BoolExpr;
}

export interface AtLeastExpr {
	readonly op: "atLeast";
	readonly count: number;
	readonly items: readonly BoolExpr[];
}

export type BoolExpr = RefExpr | AllExpr | AnyExpr | NotExpr | AtLeastExpr;

/** One of exactly two judgment kernels: a script, or a natural-language instruction. */
export type VerifierShape =
	| { readonly mode: "programmatic"; readonly script: string }
	| { readonly mode: "agentic"; readonly instruction: string };

export interface GoalNodeInput {
	readonly kind: GoalKind;
	readonly title: string;
	readonly constraint: ConstraintKind;
	/** Single file path or a directory/collection (the engine packs it into a .tar). */
	readonly target: string;
	/** Leaf: required. Composite: optional whole-object assertion (runs after the subtree settles). */
	readonly verifier?: VerifierShape;
	/** Composite only: boolean combination of children. */
	readonly completion?: BoolExpr;
}

export interface ContainsEdge {
	readonly parent: GoalId;
	readonly child: GoalId;
	readonly required: boolean;
	readonly failure: FailurePolicy;
	readonly degradeTo?: GoalId;
}

export interface DependencyEdge {
	readonly source: GoalId;
	readonly target: GoalId;
	readonly data?: readonly string[];
}

export interface DogGraphInput {
	readonly schemaVersion: typeof DOG_SCHEMA_VERSION;
	readonly id: string;
	readonly root: GoalId;
	readonly nodes: Record<GoalId, GoalNodeInput>;
	readonly contains: readonly ContainsEdge[];
	readonly dependsOn: readonly DependencyEdge[];
}

export interface DogConfig {
	readonly storageDirectory: string;
	/** Capture root: every verifier object comes from inside this tree. */
	readonly workspaceRoot: string;
	/** Host-registered programmatic script library directory. */
	readonly scriptsDirectory: string;
	readonly maxGraphNodes: number;
	readonly maxExpressionNodes: number;
	readonly maxExpressionDepth: number;
	readonly maxSandboxBytes: number;
	readonly allowPartialRoot: boolean;
	readonly maxConcurrentVerifications: number;
}

export interface GraphLimits {
	readonly maxGraphNodes: number;
	readonly maxExpressionNodes: number;
	readonly maxExpressionDepth: number;
}

/** One captured object (file, or packed .tar for a collection). */
export interface CapturedInput {
	readonly path: string;
	readonly digest: string;
	readonly exists: boolean;
	readonly byteLength: number;
	readonly sha256: string;
	/** True when the capture is a .tar of a directory/collection. */
	readonly packed?: boolean;
}

/** Deterministic or agentic: the judgment identity half of the inheritance anchor. */
export type JudgmentIdentity =
	| { readonly mode: "programmatic"; readonly script: string; readonly scriptDigest: string }
	| { readonly mode: "agentic"; readonly instructionHash: string };

/** What one goal is judged by, and the object it is judged against. */
export interface AcceptancePlan {
	readonly goalId: GoalId;
	readonly verifier: VerifierShape;
	/** Identity of the judgment source; part of the inheritance anchor. */
	readonly judgment: JudgmentIdentity;
	readonly target: string;
	/** Captured object metadata (absent when the target is missing/empty). */
	readonly input?: CapturedInput;
}

/** Who produced one verdict, for the ledger. */
export interface VerifierProvenance {
	readonly mode: "programmatic" | "agentic";
	/** Verifier session transcript (agentic kernel only). */
	readonly sessionFile?: string;
	readonly model?: string;
}

export interface VerificationRecord {
	readonly schemaVersion: "0.1";
	readonly runId: string;
	readonly graphId: string;
	readonly graphDigest: string;
	readonly goalId: GoalId;
	readonly judgment: JudgmentIdentity;
	readonly passed: boolean | null;
	readonly evidence?: JsonValue;
	readonly verifier?: VerifierProvenance;
	readonly at: string;
}

export interface GoalResult {
	readonly state: GoalState;
	readonly reason?: string;
	readonly verification?: VerificationRecord;
	readonly inheritedFrom?: string;
}

export type RootTerminalState = "success" | "partial_success" | "failure" | "infeasible" | "needs_replan" | "cancelled";

export interface CompiledGraph {
	readonly input: DogGraphInput;
	readonly graphDigest: string;
	readonly acceptancePlans: Readonly<Record<GoalId, AcceptancePlan>>;
}

export interface DogRun {
	readonly schemaVersion: "0.1";
	readonly runId: string;
	readonly graphId: string;
	readonly graphDigest: string;
	readonly state: "running" | "completed" | "cancelled" | "failed";
	readonly rootState?: RootTerminalState;
	readonly runtimeWarning?: string;
	/** Per-goal inheritance anchors (object digest + judgment identity). */
	readonly anchors: Readonly<Record<GoalId, string>>;
	readonly goals: Readonly<Record<GoalId, GoalResult>>;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface GraphValidationReport {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value === "object") return Object.values(value).every(isJsonValue);
	return false;
}

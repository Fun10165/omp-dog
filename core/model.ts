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

/**
 * What a goal judges: a workspace path, or a git tree at a ref.
 *
 * A bare string in a graph is the `path` form; the object form names a commit so
 * the object is exactly those committed bytes — the working tree does not take
 * part, and the identity is the commit, not a hash of the checkout.
 */
export type TargetSpec =
	| { readonly kind: "path"; readonly path: string }
	| { readonly kind: "git"; readonly ref: string; readonly path?: string };

export interface GoalNodeInput {
	readonly kind: GoalKind;
	readonly title: string;
	readonly constraint: ConstraintKind;
	/** A workspace-relative file/directory, or a git ref (optionally a subpath). */
	readonly target: TargetSpec;
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

/**
 * Two tiers of background, both handed to every agentic verifier.
 *
 * `general` is the stable half: what this system is, how to read what is being
 * judged. It changes when the *product* changes. `specific` is the other half:
 * only what this particular trigger needs — the user's original words, what this
 * submission is meant to solve. It changes per submission.
 */
export interface BackgroundSpec {
	readonly general?: string;
	readonly specific?: string;
}

export interface DogGraphInput {
	readonly schemaVersion: typeof DOG_SCHEMA_VERSION;
	readonly id: string;
	readonly root: GoalId;
	/**
	 * Workspace-relative markdown files handed to every agentic verifier, before
	 * the instruction: `general` first (what DoG is, how to read a graph),
	 * `specific` second (this submission's own context). Their contents are part
	 * of the judgment identity, so editing either re-judges the graph.
	 */
	readonly background?: BackgroundSpec;
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

/** One captured object (file, or a collection stored as a tree). */
export interface CapturedInput {
	readonly path: string;
	readonly digest: string;
	readonly exists: boolean;
	readonly byteLength: number;
	readonly sha256: string;
	/** True when the capture is a collection rather than a single file. */
	readonly packed?: boolean;
	/**
	 * How the stored bytes are shaped: a cloned file, a tree of cloned files
	 * (digest `tree:…`), a git tree materialized at a commit (digest `git:…`), or
	 * a legacy `.tar` (digest `sha256:…`, `packed`). Absent means a single file.
	 */
	readonly form?: "file" | "tree" | "git" | "tar";
	/** Present for a git capture: what was asked for, what it resolved to. */
	readonly git?: {
		readonly ref: string;
		readonly commit: string;
		/** Subtree path inside the repository (`""` for the whole tree). */
		readonly path: string;
	};
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
	/** As declared in the graph. */
	readonly target: TargetSpec;
	/** Workspace-relative name the object is materialized under. */
	readonly objectPath: string;
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
	/** The background, read and frozen at compile time (digest included in judgments). */
	readonly background?: FrozenBackground;
}

/** One frozen background document: where it came from, and the bytes it had. */
export interface FrozenDocument {
	readonly path: string;
	readonly sha256: string;
	readonly text: string;
}

/** Both tiers as read and frozen at compile time. */
export interface FrozenBackground {
	readonly general?: FrozenDocument;
	readonly specific?: FrozenDocument;
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

/** The one record guard: a JSON object, never an array or null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

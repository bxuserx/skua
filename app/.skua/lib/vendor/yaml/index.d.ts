// Hand-written declarations for the vendored `yaml` browser dist.
//
// The dist ships no .d.ts, and pulling the package's full type tree in would be
// far more surface than we use. This covers exactly the API frontmatter.ts and
// adrs.ts touch — the Document API, because it is the only one that round-trips
// comments and structures the parser doesn't model.
//
// Upstream: yaml@2.9.x (eemeli/yaml), browser/dist/index.js.

export interface ToStringOptions {
  /** 0 disables line folding. Required: the default (80) reflows any plain
   *  scalar longer than ~70 chars on first save, which shows up as a spurious
   *  diff on every ticket with a long title. */
  lineWidth?: number;
  indent?: number;
  nullStr?: string;
  singleQuote?: boolean | null;
  /** false emits `[a, b]`; the default true emits `[ a, b ]`. */
  flowCollectionPadding?: boolean;
}

export interface ParseOptions {
  version?: "1.1" | "1.2" | "next";
  schema?: "core" | "failsafe" | "json" | "yaml-1.1";
  keepSourceTokens?: boolean;
}

export interface YAMLError {
  name: string;
  message: string;
  code?: string;
  pos?: [number, number];
}

export declare class Document<T = unknown> {
  contents: unknown;
  errors: YAMLError[];
  warnings: YAMLError[];
  get(key: unknown, keepScalar?: boolean): unknown;
  set(key: unknown, value: unknown): void;
  has(key: unknown): boolean;
  delete(key: unknown): boolean;
  add(value: unknown): void;
  toJS(opts?: { maxAliasCount?: number }): T;
  toString(options?: ToStringOptions): string;
}

export declare function parseDocument<T = unknown>(
  source: string,
  options?: ParseOptions,
): Document<T>;

export declare function parse(source: string, options?: ParseOptions): unknown;
export declare function stringify(value: unknown, options?: ToStringOptions & ParseOptions): string;

export declare function isMap(value: unknown): boolean;
export declare function isSeq(value: unknown): boolean;
export declare function isScalar(value: unknown): boolean;

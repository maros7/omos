// Minimal ambient shim for the `bun:test` module so `tsc --noEmit` can
// typecheck the co-located *.test.ts files WITHOUT adding `@types/bun` as a
// devDependency (the tripwire plugin intentionally ships zero type-only deps).
//
// At runtime, Bun provides the real `bun:test` implementation with full types;
// this file only fills the gap for `tsc`. Keep the surface narrow: declare just
// what the tests use, generously typed so the shim never blocks a valid call.

declare module "bun:test" {
  type TestFn = () => void | Promise<void>

  export interface TestFnAlias {
    (name: string, fn: TestFn): void
    each(table: ReadonlyArray<unknown>): (name: string, fn: (...args: any[]) => void | Promise<void>) => void
    skip(name: string, fn: TestFn): void
    only(name: string, fn: TestFn): void
    todo(name: string, fn?: TestFn): void
  }

  export interface Matcher<T> {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toStrictEqual(expected: unknown): void
    toHaveLength(length: number): void
    toContain(substr: string): void
    toContainEqual(item: unknown): void
    toBeNull(): void
    toBeDefined(): void
    toBeUndefined(): void
    toBeTruthy(): void
    toBeFalsy(): void
    toBeGreaterThan(n: number): void
    toBeGreaterThanOrEqual(n: number): void
    toBeLessThan(n: number): void
    toBeLessThanOrEqual(n: number): void
    toThrow(error?: unknown): void
    not: Matcher<T>
  }

  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: TestFn): void
  export const test: TestFnAlias
  export function beforeAll(fn: () => void | Promise<void>): void
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterAll(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  export function expect<T>(actual: T): Matcher<T>
  export const mock: {
    (fn?: (...args: any[]) => unknown): any
    module(symbol: string, mocks: Record<string, unknown>): Promise<void>
  }
}

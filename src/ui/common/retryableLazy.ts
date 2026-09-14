import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// `LazyExoticComponent`'s own constraint: a component with any props, not only a prop-less one.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyComponent = ComponentType<any>;

/**
 * A lazily loaded panel that can be tried again. `React.lazy` remembers a rejected import for the
 * rest of the session, so a chunk that failed once (offline, or deleted by a deploy under an old
 * tab) would fail every later open too — `reset()` swaps in a fresh lazy wrapper around the same
 * loader.
 */
export interface RetryableLazy<T extends AnyComponent> {
  readonly Component: LazyExoticComponent<T>;
  reset(): void;
}

export function retryableLazy<T extends AnyComponent>(load: () => Promise<{ default: T }>): RetryableLazy<T> {
  let current = lazy(load);
  return {
    get Component() {
      return current;
    },
    reset() {
      current = lazy(load);
    },
  };
}

import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

/**
 * A component whose code loads on first render. `fallback` shows while it
 * loads. Wraps `React.lazy` in its own `Suspense`, so call sites render it
 * like any other component.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  function LazyComponent(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyComponent;
}

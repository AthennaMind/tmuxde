import { useEffect, useState } from "react";
import { fetchFileObjectUrl } from "./file-url";

interface FileObjectUrlState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/** State for one path on one machine. A result is only ever shown for its own. */
interface PathState extends FileObjectUrlState {
  path: string | null;
  target: string | undefined;
}

function pending(path: string | null, target: string | undefined): PathState {
  return { path, target, url: null, loading: !!path, error: false };
}

/**
 * Load a relay file as a blob object URL via the Authorization header (no
 * token in the URL) and manage its lifecycle: revokes the object URL on
 * unmount or when the path changes, and ignores stale/aborted responses.
 *
 * `target` is the machine the path lives on. Without it the active route
 * decides, which is right for the browser but not for a tab opened on
 * another machine.
 */
export function useFileObjectUrl(path: string | null, target?: string): FileObjectUrlState {
  const [state, setState] = useState(() => pending(path, target));

  // A new path starts over during render, before the effect cleanup revokes
  // the old URL. No render shows a revoked URL, and a result that lands for
  // an old path is dropped here too.
  if (state.path !== path || state.target !== target) setState(pending(path, target));

  useEffect(() => {
    if (!path) return;

    let objectUrl: string | null = null;
    const controller = new AbortController();

    fetchFileObjectUrl(path, controller.signal, target)
      .then((u) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setState({ path, target, url: u, loading: false, error: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ path, target, url: null, loading: false, error: true });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, target]);

  return state;
}

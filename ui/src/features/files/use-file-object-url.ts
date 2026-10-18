import { useEffect, useState } from "react";
import { fetchFileObjectUrl } from "./file-url";

interface FileObjectUrlState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/** State for one path. A result is only ever shown for its own path. */
interface PathState extends FileObjectUrlState {
  path: string | null;
}

function pending(path: string | null): PathState {
  return { path, url: null, loading: !!path, error: false };
}

/**
 * Load a relay file as a blob object URL via the Authorization header (no
 * token in the URL) and manage its lifecycle: revokes the object URL on
 * unmount or when the path changes, and ignores stale/aborted responses.
 */
export function useFileObjectUrl(path: string | null): FileObjectUrlState {
  const [state, setState] = useState(() => pending(path));

  // A new path starts over during render, before the effect cleanup revokes
  // the old URL. No render shows a revoked URL, and a result that lands for
  // an old path is dropped here too.
  if (state.path !== path) setState(pending(path));

  useEffect(() => {
    if (!path) return;

    let objectUrl: string | null = null;
    const controller = new AbortController();

    fetchFileObjectUrl(path, controller.signal)
      .then((u) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setState({ path, url: u, loading: false, error: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ path, url: null, loading: false, error: true });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}

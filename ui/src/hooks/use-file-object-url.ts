import { useEffect, useState } from "react";
import { fetchFileObjectUrl } from "@/lib/file-url";

interface FileObjectUrlState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * Load a relay file as a blob object URL via the Authorization header (no
 * token in the URL) and manage its lifecycle: revokes the object URL on
 * unmount or when the path changes, and ignores stale/aborted responses.
 */
export function useFileObjectUrl(path: string | null): FileObjectUrlState {
  const [state, setState] = useState<FileObjectUrlState>({
    url: null,
    loading: !!path,
    error: false,
  });

  useEffect(() => {
    if (!path) {
      setState({ url: null, loading: false, error: false });
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ url: null, loading: true, error: false });

    fetchFileObjectUrl(path, controller.signal)
      .then((u) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setState({ url: u, loading: false, error: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ url: null, loading: false, error: true });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}

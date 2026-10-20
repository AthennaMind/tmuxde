import { useCallback, useEffect, useState } from "react";
import { fetchFileStreamUrl } from "./file-url";

interface FileStreamState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/** State for one request. A result is only ever shown for its own. */
interface KeyedState extends FileStreamState {
  key: string;
}

function requestKey(path: string, target: string | undefined, generation: number): string {
  return `${generation}\0${target ?? ""}\0${path}`;
}

/**
 * A ticket URL for one file, see `fetchFileStreamUrl`. `refresh` asks for
 * a new ticket, for a media element whose ticket ran out during playback.
 *
 * `target` is the machine the path lives on. Without it the active route
 * decides.
 */
export function useFileStreamUrl(
  path: string,
  target?: string,
): FileStreamState & { refresh: () => void } {
  const [generation, setGeneration] = useState(0);
  const key = requestKey(path, target, generation);
  const [state, setState] = useState<KeyedState>(() => ({
    key,
    url: null,
    loading: true,
    error: false,
  }));

  // A new path or a refresh starts over during render, so no render shows
  // the old URL, and an answer that lands for an old request is dropped.
  if (state.key !== key) setState({ key, url: null, loading: true, error: false });

  useEffect(() => {
    const controller = new AbortController();
    fetchFileStreamUrl(path, target, controller.signal)
      .then((url) => {
        if (!controller.signal.aborted) setState({ key, url, loading: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, url: null, loading: false, error: true });
      });
    return () => controller.abort();
  }, [path, target, key]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { url: state.url, loading: state.loading, error: state.error, refresh };
}

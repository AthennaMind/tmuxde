// @ts-check

/** @param {(key: string) => void} send */
export function createKeyRepeat(send) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    stop,
    /** @param {string} key */
    start(key) {
      stop();
      send(key);
      const tick = () => {
        send(key);
        timer = setTimeout(tick, 80);
      };
      timer = setTimeout(tick, 400);
    },
  };
}

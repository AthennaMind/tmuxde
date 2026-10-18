export function createKeyRepeat(send: (key: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    stop,
    start(key: string) {
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

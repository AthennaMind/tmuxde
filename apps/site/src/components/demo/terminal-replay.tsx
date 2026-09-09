"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChapterRail, type Chapter } from "@/components/demo/chapter-rail";
import { LaptopViewport } from "@/components/demo/laptop-viewport";
import { PhoneFrame } from "@/components/demo/phone-frame";
import { Transport } from "@/components/demo/transport";
import { HOME_DEMO } from "@/lib/demo/cast";
import { chapterAt, frameAt, settledTimeAt } from "@/lib/demo/player";
import { cn } from "@/lib/utils";

/**
 * The one client island on the home page.
 *
 * State here is `{ time, playing, reduced }` and nothing per character: the
 * screen is `frameAt(HOME_DEMO, time)`, so seeking is an assignment and the
 * reduced-motion render is the same function at a settled time. The rAF loop
 * writes `time` at ~30fps, which is well under the paint budget for 20 rows of
 * text and far below the rate at which the transcript actually changes.
 *
 * It only plays while it is on screen and the tab is visible — a section
 * animating in a background tab is pure battery cost.
 */

/** Paint ceiling. The transcript has no content that needs more. */
const FRAME_MS = 1000 / 30;

/** How much of the section must be visible before it starts. */
const VISIBILITY = 0.4;

export interface ReplayLabels {
  play: string;
  pause: string;
  restart: string;
  progress: string;
  reducedNote: string;
  /** Read by screen readers in place of the two viewports. */
  description: string;
  /** Announced on each chapter change; `{title}` is substituted. */
  nowShowing: string;
  laptopTitle: string;
}

export function TerminalReplay({
  chapters,
  labels,
  className,
}: {
  chapters: Chapter[];
  labels: ReplayLabels;
  className?: string;
}) {
  const cast = HOME_DEMO;
  // Starts on the settled `pair` frame: the densest one, the same transcript
  // the page used to ship statically, and exactly what a reduced-motion
  // visitor sees. Rendering it on the server means no flash of an empty
  // terminal and no layout shift on hydrate.
  const [time, setTime] = useState(() => settledTimeAt(cast, 1));
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);

  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visible = useRef(false);
  const started = useRef(false);

  // Read the media query rather than leaning on the global `0.01ms` clamp in
  // globals.css: that clamp would make this play at 30fps through its whole
  // 30 seconds instantly, which is worse than not playing at all.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Play on scroll-into-view, pause on the way out.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || reduced) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = !!entry?.isIntersecting;
        if (!visible.current) {
          setPlaying(false);
          return;
        }
        // Rewind to the top the first time it comes into view, so the visitor
        // sees the install rather than joining halfway.
        if (!started.current) {
          started.current = true;
          setTime(0);
        }
        setPlaying(true);
      },
      { threshold: VISIBILITY },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced]);

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, []);

  useEffect(() => {
    if (!playing || reduced) return;

    last.current = performance.now();
    let accumulated = 0;

    const tick = (now: number) => {
      const delta = now - last.current;
      last.current = now;
      accumulated += delta;
      if (accumulated >= FRAME_MS) {
        // Advance by everything that has accumulated, not by the last frame's
        // delta: at 60fps only every other frame clears the threshold, so
        // crediting one delta per paint ran the whole cast at half speed.
        const elapsed = accumulated;
        accumulated = 0;
        setTime((t) => {
          const next = t + elapsed;
          if (next >= cast.duration) {
            setPlaying(false);
            return cast.duration;
          }
          return next;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [playing, reduced, cast.duration]);

  const frame = frameAt(cast, time);
  const chapter = chapterAt(cast, time);
  const ended = time >= cast.duration;
  const progress = cast.duration === 0 ? 0 : time / cast.duration;

  const selectChapter = useCallback(
    (index: number) => {
      // Land on the chapter's *start* when playing, so the visitor watches it
      // happen; on its settled frame when not, so a paused jump shows the
      // finished result rather than a blank screen.
      const target = cast.chapters[index];
      if (!target) return;
      started.current = true;
      setTime(reduced || !playing ? settledTimeAt(cast, index) : target.start);
    },
    [cast, playing, reduced],
  );

  const activeTitle = chapters[chapter]?.title ?? "";

  return (
    <div ref={rootRef} className={cn("flex flex-col gap-6", className)}>
      <p className="sr-only">{labels.description}</p>
      {/* Announced on change only — the viewports themselves are aria-hidden
          because 30fps text mutation is unusable with a screen reader. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {labels.nowShowing.replace("{title}", activeTitle)}
      </p>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17.5rem]">
        {/* Phone first on narrow viewports: the narrow viewport IS the phone. */}
        <div className="order-first lg:order-last">
          <PhoneFrame phone={frame.phone} />
        </div>

        <div className="terminal-scope relative overflow-hidden rounded-xl border border-line bg-surface-sunken shadow-lift">
          <div className="flex items-center gap-2 border-b border-line-subtle bg-surface-panel px-3.5 py-2.5">
            <span aria-hidden="true" className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-signal-failed" />
              <span className="size-2.5 rounded-full bg-signal-blocked" />
              <span className="size-2.5 rounded-full bg-signal-done" />
            </span>
            <span className="ms-2 font-mono text-[0.875rem] text-text-subtle">
              {labels.laptopTitle}
            </span>
          </div>
          <div className="overflow-x-auto p-4 sm:p-5">
            <LaptopViewport frame={frame} showCursor={!reduced || ended} />
          </div>
        </div>
      </div>

      <Transport
        playing={playing}
        ended={ended}
        progress={progress}
        reduced={reduced}
        labels={labels}
        onToggle={() => setPlaying((p) => !p)}
        onRestart={() => {
          setTime(0);
          setPlaying(true);
        }}
        onSeek={(fraction) => {
          setPlaying(false);
          started.current = true;
          setTime(fraction * cast.duration);
        }}
      />

      <ChapterRail
        chapters={chapters}
        active={chapter}
        onSelect={selectChapter}
      />
    </div>
  );
}

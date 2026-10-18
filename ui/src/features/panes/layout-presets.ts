import type { ComponentType } from "react";
import type { WindowLayoutMessage } from "@/protocol";
import {
  EvenHorizontalGlyph,
  EvenVerticalGlyph,
  MainHorizontalGlyph,
  MainVerticalGlyph,
  TiledGlyph,
} from "./layout-glyph";

type LayoutPreset = WindowLayoutMessage["preset"];

/** Presets in menu and toolbar order, with their plain names. */
export const LAYOUTS: readonly {
  preset: LayoutPreset;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { preset: "even-horizontal", label: "Side by side", icon: EvenHorizontalGlyph },
  { preset: "even-vertical", label: "Stacked", icon: EvenVerticalGlyph },
  { preset: "main-horizontal", label: "Main on top", icon: MainHorizontalGlyph },
  { preset: "main-vertical", label: "Main on left", icon: MainVerticalGlyph },
  { preset: "tiled", label: "Tiled", icon: TiledGlyph },
];

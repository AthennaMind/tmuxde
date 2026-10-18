// Sizes of the commit graph. Rows and lanes line up across rows.

/** Row height in px. Fixed, so lanes meet across rows. */
export const ROW = 28;
export const MID = ROW / 2;
/** Width of one lane in px. */
export const LANE = 14;
/** Lanes drawn at most. The rest show as a count. */
export const MAX_LANES = 24;
/** Room past the last lane for the marker of a node in a hidden lane. */
export const EDGE = 10;

/** Centre of a lane in px. */
export const laneX = (lane: number) => lane * LANE + LANE / 2;

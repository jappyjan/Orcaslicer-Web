/**
 * Types shared between the API (`@orca-web/api`) and the web client (`@orca-web/web`).
 *
 * M0 placeholder. The real surface — job descriptors, progress events, artefact
 * descriptors, the resolved profile catalog — lands with M1 and M2. Anything that
 * crosses the HTTP boundary belongs here, and nowhere else.
 */

/** The OrcaSlicer release this build is pinned to. Mirrors `ARG ORCA_VERSION` in the Dockerfile. */
export const ORCA_VERSION = '2.4.2' as const;

/** Progress line emitted by `orca-slicer --pipe`, one JSON object per line. */
export interface SliceProgress {
  plate_index: number;
  plate_count: number;
  plate_percent: number;
  total_percent: number;
  message: string;
  warning: string | null;
}

export interface TranscriptRead {
  chunk: string;
  gap: boolean;
}

/** A cursor below `dropped` is a gap, not an error: answers the oldest surviving output with `gap` set. */
export function readFrom(buffer: string, dropped: number, since: number): TranscriptRead {
  const from = Math.max(since, dropped);
  return { chunk: buffer.slice(from - dropped), gap: since < dropped };
}

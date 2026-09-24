import { gzipSync } from "node:zlib";

/** A minimal gzipped ustar writer; kept apart from the import section's builder, whose job is to write malformed archives. */
export const tarOf = (files: Record<string, string>): Buffer => {
  const parts: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, "utf8");
    const head = Buffer.alloc(512);
    head.write(name, 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};

export const bodyOf = (bytes: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

export const watchedBody = (bytes: Buffer): { body: ReadableStream<Uint8Array>; state: { cancelled: boolean; pulled: number } } => {
  const state = { cancelled: false, pulled: 0 };
  return {
    state,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    }),
  };
};

/** Like `bodyOf`, but withholds the bytes until `release()`: holds an install mid-stream, after it has taken the daemon-wide mutex. */
export const stallingBody = (bytes: Buffer): { body: ReadableStream<Uint8Array>; release: () => void } => {
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    body: new ReadableStream({
      async pull(controller) {
        await parked;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  };
};

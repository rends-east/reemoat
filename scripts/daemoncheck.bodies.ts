import { gzipSync } from "node:zlib";

/* ------------------------------------------------------------------ *
 * A tar writer, small enough to read.
 *
 * Built here rather than shelled out for the reason the import section's own
 * builder gives: neither `tar` nor `zip` is guaranteed on a CI box. This one is
 * deliberately *separate* from that builder rather than hoisted out of it — that
 * one exists to write archives no honest tool will produce, and lifting it here
 * would couple a plugin's happy path to a fixture whose whole job is to be
 * malformed.
 *
 * At module scope because three sections build one now: installing, the hooks a
 * freshly-installed plugin is seeded with, and `POST /plugins` over HTTP. Two of
 * those want the same bytes an install already proved good, and a second copy of
 * a tar writer is a second place for a checksum to be wrong.
 * ------------------------------------------------------------------ */
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

/**
 * The same bytes, plus whether anybody released the stream.
 *
 * ⚠ **The one property of this route that is argued everywhere and asserted
 * nowhere.** `PluginHost.install` cancels the request body on the busy path and
 * again in its `finally`, and `POST /plugins`'s own docblock spends a paragraph
 * on why: the relay grants a stream's window on consumption, so a reader that
 * stops parks the sender at one window, and the valve after that closes the
 * **whole tunnel for this machine**. Every plugin fixture here used `bodyOf` or
 * `stallingBody`, neither of which records a cancel — so both calls could have
 * been deleted and this driver would have stayed green. The uploads section has
 * had exactly this fixture since Q5.72.
 */
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

/**
 * The same bytes, held until the returned `release` is called.
 *
 * What it buys is the *middle* of an install, which no other body here can reach:
 * `PluginHost.install` claims the daemon-wide mutex and then awaits the stream, so
 * this is the window in which a `remove` or a `setEnabled` arrives — the window a
 * measured `DELETE` used to walk straight through, dropping the row and every
 * `plugin_data` key of a plugin the install then re-created.
 */
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

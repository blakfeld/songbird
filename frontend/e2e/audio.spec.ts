import { readFileSync, statSync } from "node:fs";
import { unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";

// A stereo sine with identical channels, written as 16-bit PCM so any browser can decode it.
function wav({ seconds = 2, rate = 8000, amplitude = 0.5, channels = 2 } = {}): Buffer {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * amplitude * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Reads PCM16 or float32 WAV and returns the RMS of every channel together, in dBFS.
function rmsDb(bytes: Buffer): number {
  const format = bytes.readUInt16LE(20);
  const bits = bytes.readUInt16LE(34);
  let at = 12;
  while (at < bytes.length - 8 && bytes.toString("ascii", at, at + 4) !== "data") at += 8 + bytes.readUInt32LE(at + 4);
  const start = at + 8;
  const size = bytes.readUInt32LE(at + 4);
  const step = bits / 8;
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let i = start; i + step <= start + size && i + step <= bytes.length; i += step) {
    const v = format === 3 ? bytes.readFloatLE(i) : bits === 16 ? bytes.readInt16LE(i) / 32768 : 0;
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
    count++;
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(Math.sqrt(sum / count));
}

// Counts native source starts, which is where a Tone Player ends up, so "it plays" needs no hook in the app.
async function trackSourceStarts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __starts: number };
    w.__starts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      if (this.buffer && this.buffer.length > 1) w.__starts++;
      return start.apply(this, args);
    };
  });
}
const starts = (page: Page) => page.evaluate(() => (window as unknown as { __starts: number }).__starts);

async function importTone(page: Page, options?: Parameters<typeof wav>[0]) {
  await page.getByRole("button", { name: "Samples", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Samples" });
  await panel.getByRole("button", { name: "Import audio…" }).first().click();
  await page.getByTestId("audio-file-input").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: wav(options) });
  const row = panel.getByRole("button", { name: /^tone, 2\.0 seconds, stereo/ });
  await expect(row).toBeVisible();
  return { panel, row };
}

test("import a WAV through the Samples panel and place it on an audio track", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: "Audio", exact: true }).click();
  await expect(page.getByRole("group", { name: /^Track 1: Audio/ })).toBeVisible();

  const { row } = await importTone(page);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^tone, measure 1 beat 1/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test("drag a sample to a new lane, loop-extend it and undo, reload and play, then download a bundle and a WAV", async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await trackSourceStarts(page);

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  const { row } = await importTone(page);

  // The new-lane zone only exists while a drag is in flight, so the drag is driven by hand.
  const from = await row.boundingBox();
  const arrangement = await page.getByRole("region", { name: "Arrangement" }).boundingBox();
  await page.mouse.move(from!.x + 20, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(arrangement!.x + 400, arrangement!.y + 200, { steps: 8 });
  const zone = page.getByTestId("new-track-drop-lane");
  await expect(zone).toBeVisible();
  const box = (await zone.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const clip = page.getByRole("button", { name: /^tone, measure \d+ beat \d+/ });
  await expect(clip).toBeVisible();
  await expect(page.getByRole("group", { name: /^Track 1: tone/ })).toBeVisible();

  // Looping first, because a plain clip stops at the end of its sample.
  await clip.click();
  await page.getByRole("switch", { name: "Loop" }).click();
  const looping = page.getByRole("button", { name: /^tone, .*looping/ });
  await expect(looping).toBeVisible();
  const before = (await looping.getAttribute("aria-label"))!;

  const handle = looping.locator('[data-handle="trim-end"]');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 400, h.y + h.height / 2, { steps: 10 });
  await page.mouse.up();
  const longer = page.getByRole("button", { name: /^tone, .*looping/ });
  await expect.poll(async () => longer.getAttribute("aria-label")).not.toBe(before);
  await expect(longer.getByTestId("repeat-mark").first()).toBeAttached();

  await page.keyboard.press("Control+z");
  await expect.poll(async () => page.getByRole("button", { name: /^tone, .*looping/ }).getAttribute("aria-label")).toBe(before);

  // Saves are debounced, so a reload straight after an edit could race the write.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^tone, .*looping/ })).toBeVisible();
  // Not "missing" after the reload means the stored audio was found again.
  await expect(page.getByText("Audio missing")).toHaveCount(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => starts(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  const bundleDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const bundle = await bundleDownload;
  expect(bundle.suggestedFilename()).toMatch(/\.songbird\.zip$/);
  const bundlePath = testInfo.outputPath("bundle.zip");
  await bundle.saveAs(bundlePath);
  expect(statSync(bundlePath).size).toBeGreaterThan(100);
  expect(readFileSync(bundlePath).subarray(0, 2).toString("latin1")).toBe("PK");

  const wavDownload = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download WAV" }).click();
  const rendered = await wavDownload;
  expect(rendered.suggestedFilename()).toMatch(/^songbird-.+-\d+bpm\.wav$/);
  const wavPath = testInfo.outputPath("mix.wav");
  await rendered.saveAs(wavPath);
  const bytes = readFileSync(wavPath);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(problems).toEqual([]);
});

test("measure how loud a centre-panned stereo sample is in the rendered mix", async ({ page }, testInfo) => {
  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: "Audio", exact: true }).click();
  const { row } = await importTone(page, { amplitude: 0.5, seconds: 2 });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^tone, measure 1 beat 1/ })).toBeVisible();

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download WAV" }).click();
  const path = testInfo.outputPath("level.wav");
  await (await download).saveAs(path);
  const mixDb = rmsDb(readFileSync(path));
  const sourceDb = rmsDb(wav({ amplitude: 0.5, seconds: 2 }));
  // The song is exactly as long as the sample, so the two averages cover the same stretch and compare directly.
  const diff = mixDb - sourceDb;
  testInfo.annotations.push({ type: "level", description: `mix RMS ${mixDb.toFixed(2)} dB, source RMS ${sourceDb.toFixed(2)} dB, diff ${diff.toFixed(2)} dB` });
  console.log(`LEVEL mix=${mixDb.toFixed(2)} source=${sourceDb.toFixed(2)} diff=${diff.toFixed(2)}`);
  expect(Number.isFinite(mixDb)).toBe(true);
});

test("assign a sample to a pad, play a note on it, and find the sample in the downloaded bundle", async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await trackSourceStarts(page);

  await page.goto("/studio");
  await expect(page.getByRole("region", { name: "Arrangement" })).toBeVisible();
  const { row } = await importTone(page);

  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByRole("menuitem", { name: "Sampler (pads)", exact: true }).click();
  const dock = page.getByRole("region", { name: /^Editor:/ });
  const pad1 = dock.getByRole("button", { name: "Pad 1, empty", exact: true });
  await expect(pad1).toBeVisible();

  await row.dragTo(pad1);
  await expect(dock.getByRole("button", { name: "Pad 1, tone", exact: true })).toBeVisible();

  const cell = dock.getByRole("button", { name: "Pad 1, measure 1, step 1", exact: true });
  await cell.click();
  await expect(cell).toHaveAttribute("aria-pressed", "true");

  // Placing a note auditions the pad, so the count is taken after that and Play must add a start beyond it.
  await expect.poll(() => starts(page)).toBeGreaterThan(0);
  const auditioned = await starts(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => starts(page), { timeout: 10_000 }).toBeGreaterThan(auditioned);
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project" }).click();
  const bundle = await download;
  expect(bundle.suggestedFilename()).toMatch(/\.songbird\.zip$/);
  const path = testInfo.outputPath("pads-bundle.zip");
  await bundle.saveAs(path);
  const entries = Object.keys(unzipSync(new Uint8Array(readFileSync(path))));
  expect(entries).toContain("project.json");
  expect(entries.filter((n) => /^audio\/.+\.wav$/.test(n))).toHaveLength(1);
  expect(problems).toEqual([]);
});

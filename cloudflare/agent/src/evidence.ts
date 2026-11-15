import type { BrowserEvidence } from "../../shared/contracts";

// Keep each storage value below 128 KiB, including on runtimes with the older KV API limits.
export async function saveEvidence(
  storage: DurableObjectStorage,
  id: string,
  evidence: BrowserEvidence,
): Promise<void> {
  const { screenshot, ...rest } = evidence;
  const chunks = screenshot ? Math.ceil(screenshot.data.length / 64_000) : 0;
  for (let i = 0; i < chunks; i++)
    await storage.put(
      `image:${id}:${i}`,
      screenshot!.data.slice(i * 64_000, (i + 1) * 64_000),
    );
  await storage.put(`evidence:${id}`, { ...rest, image_chunks: chunks });
}
export async function loadEvidence(
  storage: DurableObjectStorage,
  id: string,
): Promise<BrowserEvidence | undefined> {
  const record = await storage.get<
    Omit<BrowserEvidence, "screenshot"> & { image_chunks: number }
  >(`evidence:${id}`);
  if (!record) return undefined;
  const { image_chunks, ...rest } = record;
  if (!image_chunks) return rest;
  let data = "";
  for (let i = 0; i < image_chunks; i++) {
    const chunk = await storage.get<string>(`image:${id}:${i}`);
    if (!chunk) return { ...rest, screenshot_error: "image_incomplete" };
    data += chunk;
  }
  return { ...rest, screenshot: { data, mimeType: "image/jpeg" } };
}

// tts-test.mjs
import Replicate from "replicate";
import { writeFile } from "node:fs/promises";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const input = {
  text: "Hello from a direct Replicate test.",
  emotion: "happy",
  voice_id: "Friendly_Person",
  language_boost: "English",
  english_normalization: true,
};

const out = await replicate.run("minimax/speech-02-hd", { input });

console.log("typeof out:", typeof out, "isArray:", Array.isArray(out));
console.log("raw out (preview):", JSON.stringify(out)?.slice(0, 400));

// Handle all common shapes: string, array of strings, or object with a url()
let url = null;

// Newer SDK may return a file object with a url() method:
if (out && typeof out === "object" && typeof out.url === "function") {
  url = out.url();
}

// String or array:
if (!url) {
  if (typeof out === "string") url = out;
  else if (Array.isArray(out)) url = out[0] || null;
  else if (out && typeof out === "object" && typeof out.url === "string") url = out.url;
}

console.log("resolved url:", url);

// Optional: write to disk if Replicate returned raw bytes (rare, but just in case)
if (!url && (out instanceof Uint8Array || Buffer.isBuffer(out))) {
  await writeFile("output.mp3", out);
  console.log("Wrote output.mp3 directly from bytes");
} else if (url) {
  console.log("Download with: curl -L", url, "-o test.mp3");
}

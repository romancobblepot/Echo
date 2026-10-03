import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as cheerio from "cheerio";

export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  switch (mimeType) {
    case "application/pdf": {
      const uint8 = new Uint8Array(buffer);
      const parser = new PDFParse({ data: uint8 } as ConstructorParameters<typeof PDFParse>[0]);
      const result = await (parser as unknown as { getText(): Promise<{ text: string }> }).getText();
      return result.text;
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case "text/html": {
      const $ = cheerio.load(buffer.toString("utf-8"));
      $("script, style").remove();
      return $("body").text().replace(/\s+/g, " ").trim();
    }
    case "application/json": {
      const parsed = JSON.parse(buffer.toString("utf-8"));
      return JSON.stringify(parsed, null, 2);
    }
    case "text/plain":
    case "text/markdown":
    default:
      return buffer.toString("utf-8");
  }
}

// Recursive character-level chunking
// Tries separators in order: paragraph → line → sentence → word → character
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

function splitRecursive(
  text: string,
  maxSize: number,
  separators: string[]
): string[] {
  if (text.length <= maxSize) return [text];

  const [sep, ...rest] = separators;

  if (sep === undefined) {
    // Hard split at maxSize
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxSize) {
      chunks.push(text.slice(i, i + maxSize));
    }
    return chunks;
  }

  const parts = sep === "" ? text.split("") : text.split(sep);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      if (part.length > maxSize) {
        // Part itself is too large — recurse with next separator
        chunks.push(...splitRecursive(part, maxSize, rest));
        current = "";
      } else {
        current = part;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

export function chunkText(
  text: string,
  maxSize = 256,
  overlap = 64
): string[] {
  const rawChunks = splitRecursive(text.trim(), maxSize, SEPARATORS);
  const chunks: string[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    let chunk = rawChunks[i];

    // Prepend overlap from previous chunk
    if (i > 0 && overlap > 0) {
      const prev = rawChunks[i - 1];
      const tail = prev.slice(-overlap);
      chunk = tail + " " + chunk;
    }

    if (chunk.trim()) chunks.push(chunk.trim());
  }

  return chunks;
}

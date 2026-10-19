export const MAX_RESUME_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 100000;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 20;
type Format = "pdf" | "docx" | "txt";

class ResumeFileError extends Error {}
function reject(message: string): never {
  throw new ResumeFileError(message);
}
function textResult(
  value: string,
  format: Format,
): { text: string; format: Format } {
  const text = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (text.length > MAX_TEXT_CHARS)
    reject("简历文字超过 100,000 字符，请精简后重新上传。");
  if (!text || !/[\p{L}\p{N}]/u.test(text))
    reject(
      format === "pdf"
        ? "PDF 未提取到有效文字，可能是扫描件；请提供可复制文字的 PDF、DOCX 或 TXT。"
        : "文件没有可识别的文字，请核对文件内容。",
    );
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text))
    reject("文件包含不可识别的控制字符，可能已损坏或并非文本简历。");
  return { text, format };
}
function starts(bytes: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => bytes[index] === value);
}
function decodeText(bytes: Uint8Array): string {
  if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff]))
    reject("TXT 请另存为 UTF-8 或 GB18030 编码后上传，暂不支持 UTF-16。");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      return reject("TXT 编码无法识别，请另存为 UTF-8 或 GB18030 后上传。");
    }
  }
}

// Read bounded central-directory metadata before selectively inflating document.xml.
function documentEntry(bytes: Uint8Array): { size: number; crc: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65557);
    index--
  ) {
    if (
      view.getUint32(index, true) === 0x06054b50 &&
      index + 22 + view.getUint16(index + 20, true) === bytes.length
    ) {
      end = index;
      break;
    }
  }
  if (end < 0) reject("DOCX 压缩结构不完整，文件可能已损坏。");
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    directoryStart = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    directoryStart === 0xffffffff ||
    directorySize === 0xffffffff
  )
    reject("不支持分卷或 ZIP64 格式的 DOCX，请另存为普通 DOCX。");
  if (count > 512) reject("DOCX 内部文件过多，请移除大型附件后重新上传。");
  if (directoryStart + directorySize !== end)
    reject("DOCX 目录结构异常，文件可能已损坏。");
  let offset = directoryStart,
    document: { size: number; crc: number } | undefined,
    hasContentTypes = false;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      reject("DOCX 目录已损坏，无法读取。");
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      compressedSize = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true),
      extraLength = view.getUint16(offset + 30, true),
      commentLength = view.getUint16(offset + 32, true),
      next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) reject("DOCX 目录已损坏，无法读取。");
    if (flags & 1) reject("暂不支持加密 DOCX，请移除密码后重新上传。");
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (name === "word/document.xml") {
      if (document) reject("DOCX 含有重复正文，文件结构不明确，请另存后重试。");
      if (!size || size > MAX_XML_BYTES)
        reject("DOCX 正文展开后超过 2 MiB 或为空，请精简后重新上传。");
      if (method !== 0 && method !== 8)
        reject("DOCX 使用不支持的压缩方式，请另存为标准 DOCX。");
      const local = view.getUint32(offset + 42, true);
      if (
        local + 30 > directoryStart ||
        view.getUint32(local, true) !== 0x04034b50
      )
        reject("DOCX 正文结构损坏，无法读取。");
      const localFlags = view.getUint16(local + 6, true),
        localNameLength = view.getUint16(local + 26, true),
        start = local + 30 + localNameLength + view.getUint16(local + 28, true);
      if (localFlags & 1) reject("暂不支持加密 DOCX，请移除密码后重新上传。");
      if (
        start + compressedSize > directoryStart ||
        view.getUint16(local + 8, true) !== method ||
        new TextDecoder().decode(
          bytes.subarray(local + 30, local + 30 + localNameLength),
        ) !== name
      )
        reject("DOCX 正文与目录不一致，文件可能已损坏。");
      document = { size, crc: view.getUint32(offset + 16, true) };
    }
    offset = next;
  }
  if (
    offset !== directoryStart + directorySize ||
    !document ||
    !hasContentTypes
  )
    reject("文件不是有效 DOCX，缺少标准文档结构；请勿只修改文件扩展名。");
  return document;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function extractDocx(
  bytes: Uint8Array,
): Promise<{ text: string; format: Format }> {
  const entry = documentEntry(bytes);
  const { unzipSync } = await import("fflate");
  const files = unzipSync(bytes, {
    filter: (file) =>
      file.name === "word/document.xml" && file.originalSize <= MAX_XML_BYTES,
  });
  const content = files["word/document.xml"];
  if (
    !content ||
    content.length !== entry.size ||
    content.length > MAX_XML_BYTES ||
    crc32(content) !== entry.crc
  )
    reject("DOCX 正文校验失败，文件可能已损坏。");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return reject("DOCX 正文编码无法识别，请另存为标准 DOCX 或 UTF-8 TXT。");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    reject("DOCX 包含不支持的 XML 文档声明，请另存为标准 DOCX。");
  if (typeof DOMParser === "undefined")
    reject("DOCX 文字提取需在支持 DOMParser 的现代浏览器中完成。");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const namespaces = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
  ];
  const root = doc.documentElement;
  if (
    doc.getElementsByTagName("parsererror").length ||
    root.localName !== "document" ||
    !namespaces.includes(root.namespaceURI ?? "")
  )
    reject("DOCX 正文 XML 无效或已损坏。");
  const body = [...root.children].find(
    (element) =>
      element.localName === "body" &&
      namespaces.includes(element.namespaceURI ?? ""),
  );
  if (!body) reject("DOCX 缺少正文，无法识别简历。");
  const walker = doc.createTreeWalker(body, 1, {
    acceptNode(node) {
      const element = node as Element;
      return namespaces.includes(element.namespaceURI ?? "") &&
        ["del", "instrText"].includes(element.localName)
        ? 2
        : 1;
    },
  });
  const parts: string[] = [];
  let total = 0;
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    if (!namespaces.includes(element.namespaceURI ?? "")) continue;
    const part =
      element.localName === "t"
        ? (element.textContent ?? "")
        : ["p", "br", "cr"].includes(element.localName)
          ? "\n"
          : element.localName === "tab"
            ? "\t"
            : "";
    total += part.length;
    if (total > MAX_TEXT_CHARS)
      reject("DOCX 文字超过 100,000 字符，请精简后重新上传。");
    parts.push(part);
  }
  return textResult(parts.join(""), "docx");
}
async function extractPdf(
  bytes: Uint8Array,
): Promise<{ text: string; format: Format }> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?raw"),
  ]);
  // Keep the worker untransformed: Vite's dynamic-import helper requires window.
  const workerUrl = URL.createObjectURL(
    new Blob([worker.default], { type: "text/javascript" }),
  );
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    useWasm: false,
    useSystemFonts: true,
    stopAtErrors: true,
    disableFontFace: true,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const doc = await task.promise;
        if (doc.numPages > MAX_PDF_PAGES)
          reject("PDF 超过 20 页，请精简后重新上传。");
        if ((await doc.getPermissions()) !== null)
          reject("暂不支持加密或带权限限制的 PDF，请移除保护后重新上传。");
        const pages: string[] = [];
        let total = 0;
        for (let index = 1; index <= doc.numPages; index++) {
          const page = await doc.getPage(index),
            content = await page.getTextContent();
          let text = "",
            lastY: number | undefined;
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const y = item.transform[5] as number;
            if (
              lastY !== undefined &&
              Math.abs(y - lastY) > 2 &&
              !text.endsWith("\n")
            )
              text += "\n";
            text += item.str + (item.hasEOL ? "\n" : " ");
            lastY = y;
            if (total + text.length > MAX_TEXT_CHARS)
              reject("PDF 文字超过 100,000 字符，请精简后重新上传。");
          }
          total += text.length;
          pages.push(text);
          page.cleanup();
        }
        return textResult(pages.join("\n"), "pdf");
      })(),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () =>
            rejectTimeout(
              new ResumeFileError("PDF 解析超时，请精简文档或改用 DOCX、TXT。"),
            ),
          30000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof ResumeFileError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException")
      reject("暂不支持加密 PDF，请移除密码后重新上传。");
    return reject(
      "PDF 文字无法读取，文件可能已损坏、使用不支持的字体编码或为扫描件；请改传 DOCX、TXT 或可复制文字的 PDF。",
    );
  } finally {
    if (timer) clearTimeout(timer);
    await task.destroy().catch(() => undefined);
    URL.revokeObjectURL(workerUrl);
  }
}

export async function extractResumeFile(
  file: File,
): Promise<{ text: string; format: Format }> {
  if (!file || !file.size) reject("请选择有内容的简历文件。");
  if (file.size > MAX_RESUME_BYTES)
    reject("简历文件不能超过 3 MiB，请压缩或精简后重新上传。");
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (!["pdf", "docx", "txt"].includes(extension ?? ""))
    reject("仅支持 PDF、DOCX 和 TXT；旧版 DOC 请先另存为 DOCX。");
  const mime = file.type.toLowerCase().split(";")[0];
  const allowedMime: Record<Format, string[]> = {
    pdf: ["application/pdf"],
    docx: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "application/x-zip-compressed",
    ],
    txt: ["text/plain"],
  };
  if (
    mime &&
    mime !== "application/octet-stream" &&
    !allowedMime[extension as Format].includes(mime)
  )
    reject("文件扩展名与内容类型不匹配，请上传原始文件而非修改后缀。");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return reject("无法读取文件，请重新选择本地简历后重试。");
  }
  try {
    if (extension === "pdf") {
      if (!starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
        reject("文件内容不是 PDF，请勿只修改文件扩展名。");
      return await extractPdf(bytes);
    }
    if (extension === "docx") {
      if (!starts(bytes, [0x50, 0x4b, 0x03, 0x04]))
        reject("DOCX 文件损坏、已加密或并非标准 DOCX，请另存后重试。");
      return await extractDocx(bytes);
    }
    if (
      starts(bytes, [0x25, 0x50, 0x44, 0x46]) ||
      starts(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      starts(bytes, [0xd0, 0xcf, 0x11, 0xe0])
    )
      reject("TXT 内容实际为其他文档类型，请使用原文件扩展名上传。");
    return textResult(decodeText(bytes), "txt");
  } catch (error) {
    if (error instanceof ResumeFileError) throw error;
    return reject(
      "简历文件损坏或解析失败，请重新导出为 PDF、DOCX 或 UTF-8 TXT 后上传。",
    );
  }
}

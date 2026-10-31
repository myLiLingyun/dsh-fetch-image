/**
 * dsh-fetch-image — 宿主级工具插件。
 *
 * 注册 `fetch_image`：GET 一个 HTTP(S) 地址，把响应体当作图片交给模型。
 * 实现方式与内置 `read_image` 相同：字节先经过 `ctx.attachments.saveImage()`
 * 规范化并持久化，工具结果由「一段文字 + 一个 image content block」组成。
 *
 * 参数里的地址可以省略协议：`127.0.0.1:3570/` 会按 `http://` 处理。这样
 * 可以直接读取 MC 客户端 / mcctl 的截图接口（例如
 * `127.0.0.1:3420/ctl/prtsc`），也可以读任意返回 PNG/JPEG/WebP/GIF 的
 * HTTP 服务。
 *
 * 这里直接构造注册表所需的 ToolDefinition，而不 import
 * `@deepseek-ai/dsh-tools` 的 `defineTool`：插件目录没有 node_modules，
 * 而宿主自带的这个包不在普通模块解析路径上。定义本身只用到 JSON Schema
 * 与运行时对象，`ctx.tools.register()` 会完成同样的校验。
 *
 * @module dsh-fetch-image
 */

/** Cordis 插件名。 */
export const name = 'fetch-image';

/** 依赖工具注册表与附件存储；没有附件存储就无法把图片交给模型。 */
export const inject = ['tools', 'attachments'];

/** 单次 GET 的默认超时，留足 MC 截图接口的耗时。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 非 2xx 响应最多带回多少字节的错误正文。 */
const ERROR_BODY_BYTES = 4_096;

/** 支持的图片媒体类型（与 attachment 服务的 imageLimits 对齐）。 */
const SUPPORTED_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SIGNATURE = [255, 216, 255];

/** 图片元数据，用于工具输出 schema 与渲染。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', description: 'Durable attachment id.' },
    mediaType: {
      type: 'string',
      enum: [...SUPPORTED_MEDIA_TYPES],
      description: 'Normalized image media type.',
    },
    bytes: { type: 'integer', description: 'Normalized encoded size in bytes.' },
    width: { type: 'integer', description: 'Normalized image width in pixels.' },
    height: { type: 'integer', description: 'Normalized image height in pixels.' },
    name: { type: 'string', description: 'Display name derived from the URL.' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['width', 'height'],
      description: 'Dimensions before storage downscaled the image.',
    },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

/** 模型参数：一个地址。 */
const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description:
        'HTTP(S) URL of the image, e.g. "127.0.0.1:3570/". When the address has no scheme, http:// is assumed.',
    },
  },
  required: ['url'],
};

/** 工具输出：请求地址、最终地址（发生跳转时）与图片元数据。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description: 'The requested URL after scheme normalization.',
    },
    finalUrl: {
      type: 'string',
      description: 'The final response URL after redirects, when it differs from url.',
    },
    image: IMAGE_VALUE_SCHEMA,
  },
  required: ['url', 'image'],
};

/**
 * 判断字节是否匹配给定签名。
 * @param {Uint8Array} data - 响应体。
 * @param {number} offset - 起始偏移。
 * @param {number[]} expected - 期望的字节序列。
 * @returns {boolean} 是否匹配。
 */
function matchesBytes(data, offset, expected) {
  if (data.byteLength < offset + expected.length) return false;
  return expected.every((byte, index) => data[offset + index] === byte);
}

/**
 * 判断字节是否匹配给定 ASCII 标记。
 * @param {Uint8Array} data - 响应体。
 * @param {number} offset - 起始偏移。
 * @param {string} value - 期望的 ASCII 文本。
 * @returns {boolean} 是否匹配。
 */
function matchesAscii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * 从字节签名识别图片类型。字节比 Content-Type 更可信：截图服务偶尔会把
 * PNG 标成 application/octet-stream。
 * @param {Uint8Array} data - 响应体。
 * @returns {string | undefined} 支持的媒体类型。
 */
function sniffImageMediaType(data) {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png';
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg';
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif';
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp';
  return undefined;
}

/**
 * 归一化用户给出的地址：补上默认协议并拒绝非 HTTP(S)。
 * @param {string} input - 模型参数里的地址。
 * @returns {URL} 可请求的 URL。
 */
function normalizeUrl(input) {
  const raw = input.trim();
  if (raw.length === 0) throw new Error('url must be a non-empty string');
  let candidate;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) candidate = raw;
  else if (raw.startsWith('//')) candidate = `http:${raw}`;
  else candidate = `http://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`invalid URL "${input}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`cannot fetch "${input}": only http:// and https:// URLs are supported`);
  }
  return url;
}

/**
 * 读取响应体的文本前缀，用于非 2xx 错误说明。
 * @param {Response} response - 失败的响应。
 * @param {number} limit - 最多读取的字节数。
 * @returns {Promise<string>} 压缩后的文本片段。
 */
async function readTextPrefix(response, limit) {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = limit - total;
      if (remaining <= 0) break;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  const text = new TextDecoder().decode(concatChunks(chunks, total));
  return text.replace(/\s+/gu, ' ').trim().slice(0, 500);
}

/**
 * 合并分块字节。
 * @param {Uint8Array[]} chunks - 顺序分块。
 * @param {number} total - 总字节数。
 * @returns {Uint8Array} 连续字节。
 */
function concatChunks(chunks, total) {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 在部署的图片字节上限内读取响应体；超过上限立即取消下载。
 * @param {Response} response - 成功的响应。
 * @param {number} limit - 最大字节数。
 * @param {string} displayUrl - 用于错误信息的地址。
 * @returns {Promise<Uint8Array>} 响应体。
 */
async function readBodyWithLimit(response, limit, displayUrl) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > limit) {
      throw new Error(
        `cannot fetch "${displayUrl}": the response declares ${length} bytes, above the ${limit}-byte image limit`,
      );
    }
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new Error(
          `cannot fetch "${displayUrl}": the response exceeds the ${limit}-byte image limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  return concatChunks(chunks, total);
}

/**
 * 从 URL 生成展示用文件名；失败时回退到 fetched-image。
 * @param {URL} url - 请求地址。
 * @returns {string} 文件名。
 */
function fileNameFor(url) {
  const segment = url.pathname.split('/').filter(Boolean).at(-1);
  if (segment === undefined) return 'fetched-image';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // 保留未解码的片段即可，文件名只用于展示。
  }
  const name = decoded.trim();
  return name.length > 0 ? name.slice(0, 120) : 'fetched-image';
}

/**
 * 在调用路由的模型声明了 image 输入时才继续。与 `read_image` 一致：
 * 不支持的模型会浪费一次下载，也会在 provider 侧失败。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} exec - 工具执行上下文。
 * @param {string} displayUrl - 用于错误信息的地址。
 */
async function assertImageCapableRoute(ctx, exec, displayUrl) {
  const routed = exec.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(
      `cannot fetch "${displayUrl}" as an image: the current model route could not be resolved`,
    );
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal);
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot fetch "${displayUrl}" as an image: model "${model}" does not declare image input; switch to an image-capable model to fetch images`,
    );
  }
}

/**
 * 发起 GET 并返回图片字节；处理超时、取消、非 2xx 与大小上限。
 * @param {URL} url - 归一化后的地址。
 * @param {AbortSignal} callerSignal - 工具调用取消信号。
 * @param {number} byteLimit - 部署允许的图片字节上限。
 * @returns {Promise<{ data: Uint8Array, finalUrl: string, contentType: string }>}
 */
async function fetchImageBytes(url, callerSignal, byteLimit) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(callerSignal.reason ?? new Error('cancelled'));
  if (callerSignal.aborted) onAbort();
  else callerSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();

  const displayUrl = url.href;
  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8,*/*;q=0.1',
          'user-agent': `dsh-fetch-image/1.0 (${process.platform})`,
        },
      });
    } catch (error) {
      if (callerSignal.aborted) {
        throw new Error(`cannot fetch "${displayUrl}": cancelled`);
      }
      if (timedOut) {
        throw new Error(
          `cannot fetch "${displayUrl}": no response within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds`,
        );
      }
      const cause = error instanceof Error ? error.message : String(error);
      const detail = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw new Error(`cannot fetch "${displayUrl}": request failed (${cause}${detail})`);
    }

    if (!response.ok) {
      const snippet = await readTextPrefix(response, ERROR_BODY_BYTES);
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      throw new Error(
        `cannot fetch "${displayUrl}": HTTP ${status}${snippet.length > 0 ? `: ${snippet}` : ''}`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const data = await readBodyWithLimit(response, byteLimit, displayUrl);
    if (data.byteLength === 0) {
      throw new Error(`cannot fetch "${displayUrl}": the response body is empty`);
    }
    return { data, finalUrl: response.url || displayUrl, contentType };
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * 把附件服务的失败转成模型能照着处理的说明。
 * @param {unknown} error - saveImage 抛出的错误。
 * @param {string} displayUrl - 用于错误信息的地址。
 * @param {string} mediaType - 嗅探出的媒体类型。
 * @param {object} attachments - 附件服务。
 * @returns {never} 总是抛出。
 */
function rethrowAttachmentError(error, displayUrl, mediaType, attachments) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  const limits = attachments.imageLimits;
  switch (code) {
    case 'IMAGE_DIMENSION_TOO_LARGE':
      throw new Error(
        `cannot fetch "${displayUrl}": at least one image side exceeds the ${limits.maxImageDimension}px limit`,
        { cause: error },
      );
    case 'IMAGE_TOO_MANY_PIXELS':
      throw new Error(
        `cannot fetch "${displayUrl}": the image exceeds the ${limits.maxImagePixels}-pixel decoded-size limit`,
        { cause: error },
      );
    case 'IMAGE_TOO_LARGE':
      throw new Error(
        `cannot fetch "${displayUrl}": the image cannot be stored within the deployment's byte limits`,
        { cause: error },
      );
    case 'INVALID_IMAGE':
      throw new Error(
        `cannot fetch "${displayUrl}": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the response may be truncated or corrupt`,
        { cause: error },
      );
    case 'IMAGE_TYPE_MISMATCH':
      throw new Error(
        `cannot fetch "${displayUrl}": the bytes look like ${mediaType} but decode as a different image format`,
        { cause: error },
      );
    default:
      throw error;
  }
}

/**
 * 格式化工具结果旁的文字说明；图片本身作为相邻的 image block。
 * @param {{ url: string, finalUrl?: string, image: object }} value - 工具输出。
 * @returns {string} 模型可见的文字。
 */
function formatImageFetchOutput(value) {
  const image = value.image;
  let scaled = '';
  if (image.originalDimensions !== undefined) {
    const x = (image.originalDimensions.width / image.width).toFixed(2);
    const y = (image.originalDimensions.height / image.height).toFixed(2);
    const advice =
      x === y
        ? `multiply coordinates by ${x}`
        : `multiply x coordinates by ${x} and y coordinates by ${y}`;
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice})`;
  }
  const redirected =
    value.finalUrl !== undefined && value.finalUrl !== value.url
      ? `\n<final_url>${value.finalUrl}</final_url>`
      : '';
  return `<url>${value.url}</url>${redirected}
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`;
}

/**
 * 把一个成功的值投影成模型可见内容。
 * @param {object} value - 工具输出。
 * @returns {object[]} 文字 + 图片内容块。
 */
function imageContent(value) {
  return [
    { type: 'text', text: formatImageFetchOutput(value) },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
        ...(value.image.originalDimensions === undefined
          ? {}
          : {
              originalDimensions: {
                width: value.image.originalDimensions.width,
                height: value.image.originalDimensions.height,
              },
            }),
      },
    },
  ];
}

/**
 * 插件入口：注册 `fetch_image`。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'fetch_image',
    description:
      'GET an HTTP(S) URL and return the response image itself. Use this for screenshot or frame endpoints instead of downloading the file first. The address may omit the scheme (http:// is assumed). Only PNG/JPEG/WebP/GIF responses are accepted; large images are downscaled automatically.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => imageContent(value),
      presentationMeta: (_args, value) => ({
        url: value.url,
        ...(value.finalUrl === undefined ? {} : { finalUrl: value.finalUrl }),
        width: value.image.width,
        height: value.image.height,
      }),
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Fetch image ${args.url}`,
        kind: 'fetch',
        rawInput: args.url,
      };
    },
    async execute(args, exec) {
      if (typeof args.url !== 'string' || args.url.trim().length === 0) {
        throw new Error('url must be a non-empty string');
      }
      const url = normalizeUrl(args.url);
      const attachments = ctx.get('attachments');
      if (attachments === undefined) {
        throw new Error(`cannot fetch "${url.href}" as an image: no attachment service is mounted`);
      }
      const byteLimit = Math.min(
        attachments.imageLimits.maxImageBytes,
        attachments.imageLimits.maxMessageImageBytes,
      );
      await assertImageCapableRoute(ctx, exec, url.href);

      const { data, finalUrl, contentType } = await fetchImageBytes(url, exec.signal, byteLimit);
      const mediaType = sniffImageMediaType(data);
      if (mediaType === undefined) {
        const declared =
          contentType.length === 0 ? 'no content-type' : `content-type ${contentType}`;
        throw new Error(
          `cannot fetch "${url.href}": the response is not a PNG/JPEG/WebP/GIF image (${declared})`,
        );
      }

      let ref;
      try {
        ref = await attachments.saveImage({
          data,
          mediaType,
          name: fileNameFor(url),
        });
      } catch (error) {
        rethrowAttachmentError(error, url.href, mediaType, attachments);
      }

      return {
        url: url.href,
        ...(finalUrl === url.href ? {} : { finalUrl }),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined
            ? {}
            : {
                originalDimensions: {
                  width: ref.originalDimensions.width,
                  height: ref.originalDimensions.height,
                },
              }),
        },
      };
    },
  });
}

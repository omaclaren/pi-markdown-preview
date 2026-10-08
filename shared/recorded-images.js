// Historical image bytes only. No filesystem, URL fetching, SVG, or conversion.
import { Buffer } from "node:buffer";
export const TURN_IMAGE_LIMIT = 8;
export const TURN_IMAGE_BYTES = 512 * 1024;
export const TURN_IMAGES_BYTES = 2 * 1024 * 1024;
export const TURN_IMAGE_PIXELS = 8 * 1024 * 1024;
export const TURN_IMAGES_PIXELS = 16 * 1024 * 1024;
const ENCODED_LIMIT = Math.ceil(TURN_IMAGE_BYTES / 3) * 4;
export const IMAGE_UNAVAILABLE = Object.freeze({
 missing: "Image bytes were not recorded inline; references are not fetched.",
 format: "Only static PNG, JPEG and WebP images are supported.",
 invalid: "The recorded image is incomplete or invalid.",
 size: "The recorded image exceeds the 512 KiB byte limit.",
 pixels: "The recorded image exceeds the pixel or dimension limit.",
 total: "This turn's image byte or pixel limit was reached.",
 count: "Further recorded images are omitted (eight-image limit).",
});

function pngSize(b) {
 if (b.length < 45 || b.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') return;
 let size, data = false, offset = 8;
 for (let count = 0; offset + 12 <= b.length && count < 4096; count++) {
  const n = b.readUInt32BE(offset), tag = b.toString('ascii', offset+4, offset+8);
  if (n > b.length - offset - 12) return;
  if (['acTL','fcTL','fdAT'].includes(tag)) return 'format';
  if (tag === 'IHDR') { if (offset !== 8 || n !== 13) return; size = [b.readUInt32BE(offset+8), b.readUInt32BE(offset+12)]; }
  else if (!size) return;
  if (tag === 'IDAT') data = true;
  offset += n + 12;
  if (tag === 'IEND') return n === 0 && data && offset === b.length ? size : undefined;
 }
}

function jpegSize(b) {
 if (b.length < 12 || b[0] !== 255 || b[1] !== 216) return;
 let offset = 2, size, scan = false;
 while (offset < b.length) {
  if (b[offset++] !== 255) { if (scan) continue; return; }
  while (b[offset] === 255) offset++;
  const tag = b[offset++];
  if (tag === 0 || (tag >= 208 && tag <= 215)) { if (scan) continue; return; }
  if (tag === 217) return offset === b.length && scan ? size : undefined;
  if (tag === 216 || tag === 220 || offset + 2 > b.length) return;
  const n = b.readUInt16BE(offset);
  if (n < 2 || n > b.length - offset) return;
  if (tag >= 192 && tag <= 207 && ![196,200,204].includes(tag)) {
   if (![192,193,194].includes(tag)) return 'format';
   if (size || n < 8) return;
   size = [b.readUInt16BE(offset+5), b.readUInt16BE(offset+3)];
  }
  if (tag === 218) { if (!size) return; scan = true; }
  offset += n;
 }
}

function webpSize(b) {
 if (b.length < 20 || b.toString('ascii',0,4) !== 'RIFF' || b.toString('ascii',8,12) !== 'WEBP' || b.readUInt32LE(4)+8 !== b.length) return;
 let offset = 12, canvas, size;
 for (let count = 0; offset + 8 <= b.length && count < 4096; count++) {
  const tag = b.toString('ascii',offset,offset+4), n = b.readUInt32LE(offset+4), p = offset+8;
  if (n > b.length - p) return;
  if (tag === 'ANIM' || tag === 'ANMF') return 'format';
  if (tag === 'VP8X') {
   if (canvas || size || n !== 10) return;
   if (b[p] & 2) return 'format';
   canvas = [b.readUIntLE(p+4,3)+1,b.readUIntLE(p+7,3)+1];
  }
  if (tag === 'VP8 ' || tag === 'VP8L') {
   if (size) return;
   if (tag === 'VP8 ') {
    if (n < 10 || (b[p] & 1) || b.toString('hex',p+3,p+6) !== '9d012a') return;
    if ((b.readUInt16LE(p+6) | b.readUInt16LE(p+8)) & 49152) return 'format';
    size = [b.readUInt16LE(p+6)&16383,b.readUInt16LE(p+8)&16383];
   } else {
    if (n < 5 || b[p] !== 47 || (b[p+4] >> 5)) return;
    size = [1+b[p+1]+((b[p+2]&63)<<8),1+(b[p+2]>>6)+(b[p+3]<<2)+((b[p+4]&15)<<10)];
   }
  }
  offset = p + n + (n & 1);
 }
 return offset === b.length && size && (!canvas || (canvas[0] === size[0] && canvas[1] === size[1])) ? size : undefined;
}

/** Validate even already-projected images again at the HTML boundary. */
function validate(image) {
 if (Object.hasOwn(IMAGE_UNAVAILABLE, image?.unavailable)) return { unavailable: image.unavailable };
 let mime = image?.mimeType, data = image?.data;
 if (typeof data !== 'string' || !data) return { unavailable: 'missing' };
 if (!['image/png','image/jpeg','image/webp'].includes(mime)) return { unavailable: 'format' };
 if (data.length > ENCODED_LIMIT) return { unavailable: 'size' };
 // Strict canonical base64: don't guess at truncated or non-base64 content.
 if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { unavailable: 'invalid' };
 const bytes = Buffer.from(data,'base64');
 if (bytes.length > TURN_IMAGE_BYTES) return { unavailable: 'size' };
 if (bytes.toString('base64') !== data) return { unavailable: 'invalid' };
 const dimensions = mime === 'image/png' ? pngSize(bytes) : mime === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
 if (dimensions === 'format') return { unavailable: 'format' };
 if (!dimensions) return { unavailable: 'invalid' };
 const [width,height] = dimensions;
 if (!width || !height || width > 8192 || height > 8192 || width * height > TURN_IMAGE_PIXELS) return { unavailable: 'pixels' };
 return { mimeType: mime, data, width, height, byteLength: bytes.length };
}

/** Project only explicit image blocks inside a tool result, never strings/paths. */
export function recordedImage(block) {
 if (!block || typeof block !== 'object') return;
 if (!['image','input_image','file'].includes(block.type)) return;
 let mime = block.mimeType ?? block.mime, data = block.data;
 const source = block.source;
 if (source?.type === 'base64') { mime = source.media_type; data = source.data; }
 if (typeof mime === 'string') mime = mime.toLowerCase();
 const url = block.image_url ?? block.uri ?? block.url;
 if (block.type === 'file' && !(typeof mime === 'string' && mime.startsWith('image/'))) return;
 if (typeof url === 'string' && url.startsWith('data:')) {
  if (url.length > ENCODED_LIMIT + 64) return { unavailable: 'size' };
  const comma = url.indexOf(','), head = url.slice(0,comma);
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(head);
  if (!match || (mime && mime !== match[1].toLowerCase())) return { unavailable: 'invalid' };
  mime = match[1].toLowerCase(); data = url.slice(comma+1);
 }
 // Validate later, once event/count bounds have admitted this candidate.
 return { mimeType: mime, data };
}

export function createRecordedImageBudget() {
 let count = 0, bytes = 0, pixels = 0, limitShown = false;
 return {
  take(image) {
   if (count >= TURN_IMAGE_LIMIT) {
    if (limitShown) return;
    limitShown = true; return { unavailable: 'count' };
   }
   count++;
   const value = validate(image);
   if ('unavailable' in value) return value;
   const area = value.width * value.height;
   if (bytes + value.byteLength > TURN_IMAGES_BYTES || pixels + area > TURN_IMAGES_PIXELS) return { unavailable: 'total' };
   bytes += value.byteLength; pixels += area;
   return value;
  },
 };
}

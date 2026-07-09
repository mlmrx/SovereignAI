/**
 * Split text into overlapping chunks for retrieval.
 * Prefers paragraph boundaries, then sentence boundaries, then hard cuts.
 */
export function chunkText(text, { maxChars = 1200, overlap = 150 } = {}) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (const piece of splitLong(para, maxChars, overlap)) chunks.push(piece);
      continue;
    }
    if (current.length + para.length + 2 > maxChars) flush();
    current += (current ? '\n\n' : '') + para;
  }
  flush();

  // add overlap between adjacent chunks so context isn't cut mid-thought
  if (overlap > 0 && chunks.length > 1) {
    return chunks.map((chunk, i) => (i === 0 ? chunk : tail(chunks[i - 1], overlap) + '\n' + chunk));
  }
  return chunks;
}

function splitLong(text, maxChars, overlap) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.trim()) pieces.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += maxChars - overlap) {
        pieces.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars) {
      if (current.trim()) pieces.push(current.trim());
      current = '';
    }
    current += (current ? ' ' : '') + sentence;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function tail(text, chars) {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const space = cut.indexOf(' ');
  return space === -1 ? cut : cut.slice(space + 1);
}
